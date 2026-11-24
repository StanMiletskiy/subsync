/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../studio/translation-review');
const {prepare} = require('../studio/translation-srt');
const {formatTime} = require('../studio/srt');

class Element {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tag = tag; this.children = [];
    this.className = ''; this.value = ''; this.handlers = {};
    this.attrs = {}; this.hidden = false;
    this.classList = {toggle:(name, on) => {
      const classes = this.className.split(' ').filter(x => x && x !== name);
      if (on) classes.push(name);
      this.className = classes.join(' ');
    }};
  }
  setAttribute(key, value) {this.attrs[key] = value;}
  addEventListener(name, handler) {this.handlers[name] = handler;}
  fire(name) {this.handlers[name]();}
  append(...children) { for (const child of children) child.parent = this; this.children.push(...children); }
  insertBefore(child, next) { child.parent = this; this.children.splice(this.children.indexOf(next),0,child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  replaceChildren(...children) {this.children = children;}
  all(predicate) {
    const nodes = this.children.flatMap(child => [child, ...child.all(predicate)]);
    return nodes.filter(predicate);
  }
  querySelector(selector) {
    return this.all(node => selector[0] === '#' ? node.id === selector.slice(1) :
      node.className.split(' ').includes(selector.slice(1)))[0] || null;
  }
  focus() {this.ownerDocument.activeElement = this;}
  scrollIntoView() {this.ownerDocument.scrollTarget = this;}
}

function setup(count = 55) {
  const doc = {createElement:tag => new Element(doc, tag)};
  const section = doc.createElement('section'), ids = {};
  for (const id of ['rows','search','prev','next','page']) {
    const n = doc.createElement('div'); n.id = 'review-' + id; ids[id] = n; section.append(n);
  }
  const original = Array.from({length:count}, (_, i) => {
    const content = i === 0 ? '<i>Hello</i> &amp; welcome\r\n– Goodbye!' : i === 2 ? '42' : i === 3 ? '' : 'Spoken line ' + i;
    return String(100 + i) + '\r\n' + formatTime(2500*i) + ' --> ' + formatTime(2500*i+1500) + ' position:1' +
      (content ? '\r\n' + content : '');
  }).join('\r\n\r\n');
  const prepared = prepare(original);
  const generated = prepared.units.map(u => 'Translation ' + u.id);
  const transitions = [];
  const review = create(section, {onDirtyChange:state => transitions.push(state)});
  review.load(prepared, generated);
  const fields = () => ids.rows.all(n => n.tag === 'textarea');
  const set = (field, value) => {field.value = value; field.fire('input');};
  return {ids, section, doc, original, prepared, generated, review, transitions, fields, set};
}

test('mounts a page at a time and keeps fixed subtitle fragments outside the text editors', () => {
  const {ids, section, doc, prepared, generated, review, fields, set} = setup();
  assert.equal(section.hidden, false);
  assert.equal(ids.rows.children.length, 25);
  assert.equal(ids.page.textContent, '1–25 of 55');
  assert.equal(ids.prev.disabled, true);
  const [first, , literal, empty] = ids.rows.children;
  assert.equal(first.all(n=>n.tag==='textarea').length, 3);
  assert.equal(literal.all(n=>n.tag==='textarea').length, 0);
  assert.equal(empty.all(n=>n.tag==='textarea').length, 0);
  assert.match(fields()[0].attrs['aria-label'], /Cue 100, line 1, part 1/);
  set(fields()[0], 'Edited\nacross lines');
  assert.equal(fields()[0].value, 'Edited across lines');
  assert.equal(first.querySelector('.review-edited').hidden, false);
  const snapshot = review.getLines();
  assert.match(prepared.render(snapshot), /<i>Edited across lines<\/i>/);
  ids.next.fire('click');
  assert.equal(ids.rows.children.length, 25); assert.equal(ids.page.textContent, '26–50 of 55');
  assert.equal(doc.activeElement, doc.scrollTarget);
  ids.next.fire('click');
  assert.equal(ids.rows.children.length, 5); assert.equal(ids.next.disabled, true);
  ids.search.value = 'edited ACROSS'; ids.search.fire('input');
  assert.equal(ids.rows.children.length, 1);
  assert.equal(fields()[0].value, 'Edited across lines');
  ids.search.value = 'spoken line 51'; ids.search.fire('input');
  assert.equal(ids.rows.children.length, 1);
  assert.deepEqual(review.getLines().slice(1), generated.slice(1));
});

test('marks only the saved snapshot clean; keeps newer typing and restored changes distinct', () => {
  const {review, fields, set, generated, prepared, transitions, ids} = setup();
  set(fields()[0], 'First edit');
  const snapshot = review.getLines();
  set(fields()[0], 'More typing during save');
  assert.equal(review.markSaved(snapshot), true);
  assert.equal(review.hasUnsaved(), true);
  assert.equal(review.getLines()[0], 'More typing during save');
  set(fields()[0], 'First edit');
  assert.equal(review.hasUnsaved(), false);
  assert.deepEqual(transitions, [true, false]);
  assert.equal(ids.rows.children[0].querySelector('.review-edited').hidden, false);
  review.clear(); review.load(prepared, generated, snapshot);
  assert.equal(fields()[0].value, 'First edit'); assert.equal(review.hasUnsaved(), false);
  assert.equal(review.markSaved(snapshot), false);
  set(fields()[0], generated[0]);
  assert.equal(ids.rows.children[0].querySelector('.review-edited').hidden, true);
  assert.equal(review.hasUnsaved(), true);
});

test('locates an invalid fragment across filters and pages without discarding edits', () => {
  const {review, ids, doc, fields, set, prepared} = setup();
  const last = prepared.units.at(-1).id;
  assert.equal(review.focusUnit(last), true);
  assert.equal(doc.activeElement, fields().at(-1));
  set(doc.activeElement, ' ');
  ids.search.value = 'missing search result'; ids.search.fire('input');
  assert.equal(ids.rows.children.length, 0);
  assert.equal(review.focusUnit(undefined), false);
  assert.equal(review.focusInvalid(), true);
  assert.equal(doc.activeElement, fields().at(-1)); assert.equal(doc.activeElement.value, ' ');
  assert.equal(ids.search.value, ''); assert.equal(review.hasUnsaved(), true);
  assert.throws(() => prepared.render(review.getLines()));
  review.clear();
  assert.deepEqual(review.getLines(), []); assert.equal(review.hasUnsaved(), false);
  assert.equal(ids.rows.children.length, 0);
});

test('the optional contrast link focuses an affected field on demand and is cleared with the previous review', () => {
  const {review, prepared, generated, section, doc, ids} = setup();
  const last = prepared.units.at(-1).id;
  review.load(prepared,generated,generated,[last]);
  const jump = section.all(n => n.tag === 'button' && /Go to cue/.test(n.textContent))[0];
  assert.ok(jump);
  assert.equal(doc.activeElement,undefined);
  assert.equal(ids.page.textContent,'1–25 of 55');
  jump.fire('click');
  assert.equal(ids.page.textContent,'51–55 of 55');
  assert.equal(doc.activeElement.attrs['aria-describedby'],'review-contrast-note');
  assert.ok(ids.rows.children.at(-1).all(n => n.textContent === 'Check word choice').length);
  assert.equal(review.hasUnsaved(),false);
  review.clear(); review.load(prepared,generated);
  assert.equal(section.all(n => n.tag === 'button' && /Go to cue/.test(n.textContent)).length,0);
});
