'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

class FakeFileHandle {
  constructor(name, content = '') {
    this.kind = 'file';
    this.name = name;
    this.content = content;
  }
  async createWritable() {
    return {
      write: async (data) => { this.content = String(data); },
      close: async () => {},
    };
  }
  async getFile() {
    return { text: async () => this.content };
  }
}

class FakeDirectoryHandle {
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    this.files = new Map();
    this.dirs = new Map();
  }
  async getFileHandle(name, opts = {}) {
    if (!this.files.has(name)) {
      if (!opts.create) throw new Error('file not found: ' + name);
      this.files.set(name, new FakeFileHandle(name));
    }
    return this.files.get(name);
  }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.dirs.has(name)) {
      if (!opts.create) throw new Error('directory not found: ' + name);
      this.dirs.set(name, new FakeDirectoryHandle(name));
    }
    return this.dirs.get(name);
  }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
  async *entries() {
    for (const entry of this.files) yield entry;
    for (const entry of this.dirs) yield entry;
  }
}

function makeFileReaderStub() {
  return class FakeFileReader {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.result = '';
    }
    readAsDataURL() {
      this.result = 'data:image/jpeg;base64,ZmFrZQ==';
      if (this.onload) this.onload();
    }
  };
}

function loadNativeStorage(fsImpl) {
  const Capacitor = {
    isNativePlatform: () => true,
    convertFileSrc: (uri) => 'webview://' + uri,
    Plugins: { Filesystem: fsImpl },
  };
  return loadModule([
    'js/storage/capacitor-adapter.js',
    'js/storage/fsa-adapter.js',
    'js/storage/storage-adapter.js',
    'js/fs-output.js',
    'js/project.js',
    'js/dataset.js',
  ], {
    globals: {
      Capacitor,
      Blob,
      FileReader: makeFileReaderStub(),
    },
  });
}

function makeNativeFs({ tree = false } = {}) {
  const calls = [];
  const fileData = new Map();
  const entries = new Map();

  function addDir(path, children) {
    entries.set(path, children);
  }
  function addFile(path, data) {
    fileData.set(path, data);
  }

  if (tree) {
    addDir('PalmAnnotate/dataset', [
      { name: 'images', type: 'directory' },
      { name: 'labels', type: 'directory' },
    ]);
    addDir('PalmAnnotate/dataset/images', [
      { name: 'train', type: 'directory' },
    ]);
    addDir('PalmAnnotate/dataset/images/train', [
      { name: 'DAMIMAS_A21B_0001_1.jpg', type: 'file' },
      { name: 'DAMIMAS_A21B_0001_2.jpg', type: 'file' },
    ]);
    addDir('PalmAnnotate/dataset/labels', [
      { name: 'train', type: 'directory' },
    ]);
    addDir('PalmAnnotate/dataset/labels/train', [
      { name: 'DAMIMAS_A21B_0001_1.txt', type: 'file' },
    ]);
    addDir('PalmAnnotate/Output TXT', [
      { name: 'train', type: 'directory' },
    ]);
    addDir('PalmAnnotate/Output TXT/train', [
      { name: 'DAMIMAS_A21B_0001_1.txt', type: 'file' },
    ]);
    addFile('PalmAnnotate/dataset/labels/train/DAMIMAS_A21B_0001_1.txt', '0 0.1 0.1 0.2 0.2');
    addFile('PalmAnnotate/Output TXT/train/DAMIMAS_A21B_0001_1.txt', '2 0.5 0.5 0.2 0.2');
  }

  const fsImpl = {
    calls,
    async mkdir(args) {
      calls.push(['mkdir', { ...args }]);
    },
    async writeFile(args) {
      calls.push(['writeFile', { ...args }]);
      fileData.set(args.path, args.data);
    },
    async readdir(args) {
      calls.push(['readdir', { ...args }]);
      if (!entries.has(args.path)) throw new Error('missing dir: ' + args.path);
      return { files: entries.get(args.path) };
    },
    async readFile(args) {
      calls.push(['readFile', { ...args }]);
      if (!fileData.has(args.path)) throw new Error('missing file: ' + args.path);
      return { data: fileData.get(args.path) };
    },
    async getUri(args) {
      calls.push(['getUri', { ...args }]);
      return { uri: 'file:///documents/' + args.path };
    },
  };

  return fsImpl;
}

test('CapacitorAdapter writes JSON, labels, and captured data to the intended app-external PalmAnnotate folders', async () => {
  const fsImpl = makeNativeFs();
  const ctx = loadNativeStorage(fsImpl);

  assert.equal(ctx.Storage.active(), ctx.CapacitorAdapter);

  const jsonResult = await ctx.FsOutput.saveJSON('DAMIMAS_A21B_0001.json', { tree_name: 'DAMIMAS_A21B_0001' });
  const trainLabel = await ctx.FsOutput.saveLabelFile('DAMIMAS_A21B_0001_1.txt', '2 0.5 0.5 0.1 0.1', 'train');
  const unknownLabel = await ctx.FsOutput.saveLabelFile('FIELD_0001_1.txt', '', 'unknown');
  await ctx.CapacitorAdapter.writeDatasetJson('metadata/FIELD_0001.json', { tree: 'FIELD_0001' });
  await ctx.CapacitorAdapter.persistDatasetImage('images/field/FIELD_0001_1.jpg', new Blob(['fake'], { type: 'image/jpeg' }));

  assert.deepEqual(jsonResult, { ok: true, method: 'native' });
  assert.deepEqual(trainLabel, { ok: true, method: 'native' });
  assert.deepEqual(unknownLabel, { ok: true, method: 'native' });

  const writes = fsImpl.calls.filter(([kind]) => kind === 'writeFile').map(([, args]) => args);
  assert.deepEqual(writes.map(w => w.path), [
    'PalmAnnotate/Output JSON/DAMIMAS_A21B_0001.json',
    'PalmAnnotate/Output TXT/train/DAMIMAS_A21B_0001_1.txt',
    'PalmAnnotate/Output TXT/FIELD_0001_1.txt',
    'PalmAnnotate/dataset/metadata/FIELD_0001.json',
    'PalmAnnotate/dataset/images/field/FIELD_0001_1.jpg',
  ]);
  assert.ok(writes.every(w => w.directory === 'EXTERNAL'));
  assert.equal(writes[0].encoding, 'utf8');
  assert.equal(writes[1].encoding, 'utf8');
  assert.equal(writes[3].encoding, 'utf8');
});

test('Android dataset load reads Output TXT corrections outside dataset and prefers them over original labels', async () => {
  const fsImpl = makeNativeFs({ tree: true });
  const ctx = loadNativeStorage(fsImpl);

  const trees = await ctx.DatasetManager.loadFromAdapter();
  assert.equal(trees.length, 1);
  assert.equal(trees[0].name, 'DAMIMAS_A21B_0001');
  assert.equal(trees[0].split, 'train');
  assert.equal(trees[0].sides.length, 2);

  const side1 = trees[0].sides[0];
  assert.equal(side1.imagePath, 'PalmAnnotate/dataset/images/train/DAMIMAS_A21B_0001_1.jpg');
  assert.equal(side1.labelPath, 'PalmAnnotate/Output TXT/train/DAMIMAS_A21B_0001_1.txt');
  assert.match(side1.imageUri, /^file:\/\/\/documents\/PalmAnnotate\/dataset\/images\/train\//);
  assert.match(side1.labelUri, /^file:\/\/\/documents\/PalmAnnotate\/Output TXT\/train\//);

  const labelText = await ctx.DatasetManager.labelTextForSide(side1);
  assert.equal(labelText, '2 0.5 0.5 0.2 0.2');
  const readCalls = fsImpl.calls.filter(([kind]) => kind === 'readFile').map(([, args]) => args);
  assert.deepEqual(readCalls.at(-1), {
    path: 'PalmAnnotate/Output TXT/train/DAMIMAS_A21B_0001_1.txt',
    encoding: 'utf8',
    directory: 'EXTERNAL',
  });
});

test('CapacitorAdapter sanitizes filenames and split paths before native writes', async () => {
  const fsImpl = makeNativeFs();
  const ctx = loadNativeStorage(fsImpl);

  await ctx.FsOutput.saveJSON('..\\escape\\TREE_0001.json', { ok: true });
  await ctx.FsOutput.saveLabelFile('../labels/TREE_0001_1.txt', '0 0.5 0.5 0.2 0.2', '../train');
  await ctx.CapacitorAdapter.writeDatasetJson('../../metadata/../FIELD_0001.json', { tree: 'FIELD_0001' });
  await ctx.CapacitorAdapter.persistDatasetImage('../../images/field/../FIELD_0001_1.jpg', new Blob(['fake'], { type: 'image/jpeg' }));

  const paths = fsImpl.calls.filter(([kind]) => kind === 'writeFile').map(([, args]) => args.path);
  assert.deepEqual(paths, [
    'PalmAnnotate/Output JSON/TREE_0001.json',
    'PalmAnnotate/Output TXT/_train/TREE_0001_1.txt',
    'PalmAnnotate/dataset/metadata/FIELD_0001.json',
    'PalmAnnotate/dataset/images/field/FIELD_0001_1.jpg',
  ]);
  assert.equal(paths.some(path => path.includes('..') || path.includes('\\')), false);
});

test('CapacitorAdapter.deleteDatasetTree unlinks a tree\'s images, metadata, and output JSON (ignoring missing files)', async () => {
  const fsImpl = makeNativeFs();
  const deleted = [];
  // Simulate a real device: side 1 exists, side 2 is already gone (throws).
  fsImpl.deleteFile = async (args) => {
    if (args.path.endsWith('_2.jpg')) throw new Error('File does not exist');
    deleted.push(args);
  };
  const ctx = loadNativeStorage(fsImpl);

  const res = await ctx.CapacitorAdapter.deleteDatasetTree('DAMIMAS_A21B_0001', 4);
  assert.equal(res.ok, true, 'never throws even when some files are missing');

  const paths = deleted.map(a => a.path);
  assert.ok(deleted.every(a => a.directory === 'EXTERNAL'), 'deletes from the app-external root');
  assert.ok(paths.includes('PalmAnnotate/dataset/images/field/DAMIMAS_A21B_0001_1.jpg'));
  assert.ok(paths.includes('PalmAnnotate/dataset/images/field/DAMIMAS_A21B_0001_4.jpg'));
  assert.ok(paths.includes('PalmAnnotate/dataset/metadata/DAMIMAS_A21B_0001.json'));
  assert.ok(paths.includes('PalmAnnotate/Output JSON/DAMIMAS_A21B_0001.json'));
  // sideCount 4 → never reaches a 5th side; the missing _2.jpg was swallowed.
  assert.ok(!paths.some(p => p.endsWith('_5.jpg')), 'respects the side count');
  assert.ok(!paths.some(p => p.endsWith('_2.jpg')), 'the throwing (missing) file is skipped');
});

test('FsaAdapter keeps output JSON and corrected labels in their separately chosen folders', async () => {
  const outputDir = new FakeDirectoryHandle('Output JSON');
  const labelsDir = new FakeDirectoryHandle('Output TXT');
  const pickerQueue = [outputDir, labelsDir];
  const ctx = loadModule([
    'js/storage/fsa-adapter.js',
    'js/storage/storage-adapter.js',
    'js/fs-output.js',
    'js/project.js',
  ], {
    globals: {
      showDirectoryPicker: async () => pickerQueue.shift(),
      Blob,
    },
  });

  assert.equal(await ctx.ProjectConfig.pickOutputDirectory(), true);
  assert.equal(await ctx.ProjectConfig.pickLabelsDirectory(), true);

  const jsonResult = await ctx.FsOutput.saveJSON('DAMIMAS_A21B_0001.json', { ok: true }, { allowDownload: false });
  const labelResult = await ctx.FsOutput.saveLabelFile('DAMIMAS_A21B_0001_1.txt', '1 0.5 0.5 0.2 0.2', 'val', { allowDownload: false });

  assert.deepEqual(jsonResult, { ok: true, method: 'filesystem' });
  assert.deepEqual(labelResult, { ok: true, method: 'filesystem' });
  assert.equal(outputDir.files.get('DAMIMAS_A21B_0001.json').content, '{\n  "ok": true\n}');
  assert.equal(labelsDir.dirs.get('val').files.get('DAMIMAS_A21B_0001_1.txt').content, '1 0.5 0.5 0.2 0.2');
  assert.equal(outputDir.dirs.has('val'), false);
  assert.equal(labelsDir.files.has('DAMIMAS_A21B_0001.json'), false);
});

test('FsaAdapter sanitizes output filenames and split names before filesystem writes', async () => {
  const outputDir = new FakeDirectoryHandle('Output JSON');
  const labelsDir = new FakeDirectoryHandle('Output TXT');
  const pickerQueue = [outputDir, labelsDir];
  const ctx = loadModule([
    'js/storage/fsa-adapter.js',
    'js/storage/storage-adapter.js',
    'js/fs-output.js',
    'js/project.js',
  ], {
    globals: {
      showDirectoryPicker: async () => pickerQueue.shift(),
      Blob,
    },
  });

  assert.equal(await ctx.ProjectConfig.pickOutputDirectory(), true);
  assert.equal(await ctx.ProjectConfig.pickLabelsDirectory(), true);

  await ctx.FsOutput.saveJSON('../escape/TREE_0001.json', { ok: true }, { allowDownload: false });
  await ctx.FsOutput.saveLabelFile('..\\labels\\TREE_0001_1.txt', 'x', '../val', { allowDownload: false });

  assert.equal(outputDir.files.has('TREE_0001.json'), true);
  assert.equal(outputDir.files.has('../escape/TREE_0001.json'), false);
  assert.equal(labelsDir.dirs.has('_val'), true);
  assert.equal(labelsDir.dirs.get('_val').files.has('TREE_0001_1.txt'), true);
  assert.equal(labelsDir.dirs.has('../val'), false);
});
