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
  constructor(name, permission = 'granted') {
    this.kind = 'directory';
    this.name = name;
    this.permission = permission;
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
      this.dirs.set(name, new FakeDirectoryHandle(name, this.permission));
    }
    return this.dirs.get(name);
  }
  async queryPermission() {
    return this.permission;
  }
  async requestPermission() {
    return this.permission;
  }
  async *entries() {
    for (const entry of this.files) yield entry;
    for (const entry of this.dirs) yield entry;
  }
}

function loadProjectWithFsa(pickerQueue = []) {
  return loadModule([
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
}

test('ProjectConfig resets saved tree state and clears selected output/label folders', async () => {
  const outputDir = new FakeDirectoryHandle('Output JSON');
  const labelsDir = new FakeDirectoryHandle('Output TXT');
  const ctx = loadProjectWithFsa([outputDir, labelsDir]);

  assert.deepEqual(ctx.ProjectConfig.get(), {
    hasOutputDir: false,
    outputDirName: '',
    hasLabelsDir: false,
    labelsDirName: '',
  });

  assert.equal(await ctx.ProjectConfig.pickOutputDirectory(), true);
  assert.equal(await ctx.ProjectConfig.pickLabelsDirectory(), true);
  ctx.ProjectConfig.markSaved('DAMIMAS_A21B_0001');
  ctx.ProjectConfig.setSavedHandle('DAMIMAS_A21B_0001', { id: 'saved-handle' });

  assert.deepEqual(ctx.ProjectConfig.get(), {
    hasOutputDir: true,
    outputDirName: 'Output JSON',
    hasLabelsDir: true,
    labelsDirName: 'Output TXT',
  });
  assert.equal(ctx.ProjectConfig.getOutputDirHandle(), outputDir);
  assert.equal(ctx.ProjectConfig.getLabelsDirHandle(), labelsDir);
  assert.equal(ctx.ProjectConfig.isSaved('DAMIMAS_A21B_0001'), true);
  assert.equal(ctx.ProjectConfig.getSavedCount(), 1);
  assert.deepEqual(ctx.ProjectConfig.getSavedHandle('DAMIMAS_A21B_0001'), { id: 'saved-handle' });

  ctx.ProjectConfig.clearLabelsDirectory();
  assert.deepEqual(ctx.ProjectConfig.get(), {
    hasOutputDir: true,
    outputDirName: 'Output JSON',
    hasLabelsDir: false,
    labelsDirName: '',
  });

  ctx.ProjectConfig.reset();
  assert.deepEqual(ctx.ProjectConfig.get(), {
    hasOutputDir: false,
    outputDirName: '',
    hasLabelsDir: false,
    labelsDirName: '',
  });
  assert.equal(ctx.ProjectConfig.isSaved('DAMIMAS_A21B_0001'), false);
  assert.equal(ctx.ProjectConfig.getSavedCount(), 0);
  assert.equal(ctx.ProjectConfig.getSavedHandle('DAMIMAS_A21B_0001'), null);
});

test('FsOutput.saveBatch delegates every item and reports saved versus failed writes', async () => {
  const calls = [];
  const fakeAdapter = {
    async saveJSON(filename, data) {
      calls.push({ filename, data });
      if (filename.includes('fail')) {
        return { ok: false, method: 'none', error: 'simulated failure' };
      }
      return { ok: true, method: filename.includes('download') ? 'download' : 'filesystem' };
    },
  };
  const ctx = loadModule('js/fs-output.js', {
    globals: {
      Storage: { active: () => fakeAdapter },
    },
  });

  const result = await ctx.FsOutput.saveBatch([
    { filename: 'TREE_A.json', data: { tree: 'A' } },
    { filename: 'TREE_fail.json', data: { tree: 'B' } },
    { filename: 'TREE_download.json', data: { tree: 'C' } },
  ]);

  assert.deepEqual(calls, [
    { filename: 'TREE_A.json', data: { tree: 'A' } },
    { filename: 'TREE_fail.json', data: { tree: 'B' } },
    { filename: 'TREE_download.json', data: { tree: 'C' } },
  ]);
  assert.deepEqual(result, { saved: 2, failed: 1, method: 'download' });
});

test('FsaAdapter lists resumable output JSON and prefers canonical names over legacy names', async () => {
  const outputDir = new FakeDirectoryHandle('Output JSON');
  const legacy = new FakeFileHandle('old__DAMIMAS_A21B_0001.json', '{"tree_name":"legacy"}');
  const canonical = new FakeFileHandle('DAMIMAS_A21B_0001.json', '{"tree_name":"canonical"}');
  outputDir.files.set(legacy.name, legacy);
  outputDir.files.set(canonical.name, canonical);
  outputDir.files.set('ignored.txt', new FakeFileHandle('ignored.txt', '{}'));
  outputDir.files.set('notatree.json', new FakeFileHandle('notatree.json', '{}'));

  const ctx = loadProjectWithFsa([outputDir]);
  assert.equal(await ctx.ProjectConfig.pickOutputDirectory(), true);

  const files = await ctx.FsOutput.listOutputFiles();
  assert.deepEqual([...files.keys()], ['DAMIMAS_A21B_0001']);
  assert.equal(files.get('DAMIMAS_A21B_0001'), canonical);
  assert.deepEqual(await ctx.FsOutput.readJSON(files.get('DAMIMAS_A21B_0001')), {
    tree_name: 'canonical',
  });
});

test('FsaAdapter does not list output files when write permission is denied', async () => {
  const outputDir = new FakeDirectoryHandle('Output JSON', 'denied');
  outputDir.files.set('DAMIMAS_A21B_0001.json', new FakeFileHandle('DAMIMAS_A21B_0001.json', '{}'));

  const ctx = loadProjectWithFsa([outputDir]);
  assert.equal(await ctx.ProjectConfig.pickOutputDirectory(), true);
  assert.equal(await ctx.FsOutput.verifyAccess(), false);
  assert.deepEqual([...(await ctx.FsOutput.listOutputFiles()).keys()], []);
});

test('FsaAdapter fallback downloads use sanitized filenames and never create wrong folders', async () => {
  const downloads = [];
  const revoked = [];
  const bodyChildren = [];
  const document = {
    body: {
      appendChild(el) { bodyChildren.push(el); },
    },
    createElement(tag) {
      assert.equal(tag, 'a');
      return {
        href: '',
        download: '',
        click() { downloads.push({ href: this.href, download: this.download }); },
        remove() {},
      };
    },
  };
  const URLStub = {
    createObjectURL(blob) {
      assert.ok(blob instanceof Blob);
      return `blob:test-${downloads.length}`;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };
  const ctx = loadModule([
    'js/storage/fsa-adapter.js',
    'js/storage/storage-adapter.js',
    'js/fs-output.js',
  ], {
    globals: {
      document,
      URL: URLStub,
      Blob,
      setTimeout(fn) { fn(); },
    },
  });

  const jsonResult = await ctx.FsOutput.saveJSON('../bad/TREE_0001.json', { ok: true });
  const labelNoDir = await ctx.FsOutput.saveLabelFile('../bad/TREE_0001_1.txt', 'x', '../train');
  const labelDownload = await ctx.FsOutput.saveLabelFile('../bad/TREE_0001_1.txt', 'x', '../train', { allowDownload: true });

  assert.deepEqual(jsonResult, { ok: true, method: 'download' });
  assert.deepEqual(labelNoDir, {
    ok: false,
    method: 'none',
    error: 'No writable label folder is available.',
  });
  assert.deepEqual(labelDownload, { ok: true, method: 'download' });
  assert.deepEqual(downloads.map(d => d.download), ['TREE_0001.json', 'TREE_0001_1.txt']);
  assert.equal(downloads.some(d => d.download.includes('/') || d.download.includes('\\') || d.download.includes('..')), false);
  assert.equal(bodyChildren.length, 2);
  assert.deepEqual(revoked, ['blob:test-0', 'blob:test-1']);
});
