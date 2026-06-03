'use strict';

import assert from 'node:assert';

export function makeCanvasContext() {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    drawImage() {},
    beginPath() {},
    closePath() {},
    rect() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    clip() {},
    stroke() {},
    fill() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    rotate() {},
    setTransform() {},
    resetTransform() {},
    setLineDash() {},
    fillText() {},
    strokeText() {},
    measureText(text) { return { width: String(text || '').length * 7 }; },
    getImageData(_x, _y, w, h) {
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
    putImageData() {},
  };
}

class FakeStyle {
  setProperty(name, value) {
    this[name] = value;
  }
}

class FakeClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }

  _load(value) {
    this.set = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  _sync() {
    this.el._className = Array.from(this.set).join(' ');
  }

  add(...names) {
    for (const name of names) if (name) this.set.add(name);
    this._sync();
  }

  remove(...names) {
    for (const name of names) this.set.delete(name);
    this._sync();
  }

  toggle(name, force) {
    if (force === true) {
      this.set.add(name);
      this._sync();
      return true;
    }
    if (force === false) {
      this.set.delete(name);
      this._sync();
      return false;
    }
    if (this.set.has(name)) {
      this.set.delete(name);
      this._sync();
      return false;
    }
    this.set.add(name);
    this._sync();
    return true;
  }

  contains(name) {
    return this.set.has(name);
  }
}

export class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.ownerDocument = null;
    this.style = new FakeStyle();
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this._className = '';
    this._textContent = '';
    this.value = '';
    this.type = '';
    this.disabled = false;
    this.readOnly = false;
    this.hidden = false;
    this.id = '';
    this.title = '';
    this.placeholder = '';
    this.clientWidth = 1000;
    this.clientHeight = 1000;
    this.width = 1000;
    this.height = 1000;
    this._rect = { left: 0, top: 0, width: 1000, height: 1000 };
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value || '');
    this.classList._load(this._className);
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this._textContent + this.children.map(c => c.textContent || '').join('');
  }

  set textContent(value) {
    this._textContent = String(value ?? '');
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML || this.textContent;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || '');
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._textContent = '';
  }

  appendChild(child) {
    if (child == null) return child;
    if (typeof child === 'string') {
      const text = new FakeElement('#text');
      text.textContent = child;
      child = text;
    }
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  insertBefore(child, before) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    const idx = this.children.indexOf(before);
    if (idx === -1) this.children.push(child);
    else this.children.splice(idx, 0, child);
    return child;
  }

  setAttribute(name, value) {
    const key = String(name);
    const val = String(value);
    this.attributes.set(key, val);
    if (key === 'class') this.className = val;
    if (key === 'id') this.id = val;
    if (key.startsWith('data-')) {
      this.dataset[dataKey(key.slice(5))] = val;
    }
  }

  getAttribute(name) {
    const key = String(name);
    if (key === 'class') return this.className;
    if (key === 'id') return this.id || null;
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    const set = this.listeners.get(type);
    if (set) set.delete(handler);
  }

  dispatchEvent(event) {
    const e = event || {};
    if (!e.type) throw new Error('Fake event requires a type.');
    if (!e.target) e.target = this;
    e.currentTarget = this;
    if (!e.preventDefault) e.preventDefault = () => { e.defaultPrevented = true; };
    if (!e.stopPropagation) e.stopPropagation = () => { e.cancelBubble = true; };
    const set = this.listeners.get(e.type);
    if (set) {
      for (const handler of Array.from(set)) handler.call(this, e);
    }
    return !e.defaultPrevented;
  }

  click() {
    const ok = this.dispatchEvent({ type: 'click', target: this });
    if (typeof this.onclick === 'function') {
      this.onclick({ type: 'click', target: this, currentTarget: this, preventDefault() {} });
    }
    return ok;
  }

  focus() {}
  blur() {}
  setPointerCapture() {}
  releasePointerCapture() {}

  getContext() {
    if (!this._ctx) this._ctx = makeCanvasContext();
    return this._ctx;
  }

  toDataURL() {
    return 'data:,';
  }

  toBlob(resolve) {
    resolve(new Blob(['canvas'], { type: 'image/png' }));
  }

  play() {
    return Promise.resolve();
  }

  getBoundingClientRect() {
    return {
      left: this._rect.left,
      top: this._rect.top,
      width: this.clientWidth,
      height: this.clientHeight,
      right: this._rect.left + this.clientWidth,
      bottom: this._rect.top + this.clientHeight,
    };
  }

  matches(selector) {
    const sel = String(selector || '').trim();
    if (!sel) return false;
    if (sel.startsWith('.')) {
      return sel.split('.').filter(Boolean).every(cls => this.classList.contains(cls));
    }
    const dataMatch = sel.match(/^\[data-([a-z0-9-]+)="([^"]*)"\]$/i);
    if (dataMatch) {
      return this.dataset[dataKey(dataMatch[1])] === dataMatch[2];
    }
    const attrMatch = sel.match(/^\[([a-z0-9-]+)="([^"]*)"\]$/i);
    if (attrMatch) {
      return this.getAttribute(attrMatch[1]) === attrMatch[2];
    }
    return this.tagName.toLowerCase() === sel.toLowerCase();
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches && cur.matches(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    walk(this, node => {
      if (node !== this && node.matches && node.matches(selector)) out.push(node);
    });
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html');
    this.head = new FakeElement('head');
    this.body = new FakeElement('body');
    this.documentElement.ownerDocument = this;
    this.head.ownerDocument = this;
    this.body.ownerDocument = this;
    this.documentElement.append(this.head, this.body);
  }

  createElement(tagName) {
    const el = new FakeElement(tagName);
    el.ownerDocument = this;
    if (String(tagName).toLowerCase() === 'canvas') {
      el.clientWidth = 1000;
      el.clientHeight = 1000;
      el.width = 1000;
      el.height = 1000;
    }
    return el;
  }

  getElementById(id) {
    return find(this.documentElement, node => node.id === id) || null;
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  addEventListener() {}
  removeEventListener() {}
}

function dataKey(name) {
  return String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function walk(root, fn) {
  fn(root);
  for (const child of root.children || []) walk(child, fn);
}

function find(root, predicate) {
  let found = null;
  walk(root, node => {
    if (!found && predicate(node)) found = node;
  });
  return found;
}

export function makeDom() {
  const document = new FakeDocument();
  return { document };
}

export function findByText(root, tagName, text) {
  const tag = String(tagName).toUpperCase();
  return find(root, node => node.tagName === tag && node.textContent === text) || null;
}

export function getByText(root, tagName, text) {
  const node = findByText(root, tagName, text);
  assert.ok(node, `Expected <${tagName}> with text "${text}"`);
  return node;
}

export async function waitFor(fn, { timeoutMs = 1000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for condition.');
}
