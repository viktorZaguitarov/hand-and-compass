#!/usr/bin/env node
'use strict';

// Fast contract smoke for the isolated walk experiment. Browser gestures and
// keyboard appearance remain manual checks because this has no dependencies.
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'walk.html'), 'utf8');
const must = [
  'hnc_walk_view_v1', 'hnc_walk_records_v1', 'hnc_walk_added_v1', 'hnc_walk_route_v1',
  'Свой вариант', 'Пропустить', 'Вымышленный собеседник', 'Почему так?',
  'Оставить свою мысль', 'Сохранить только у истории', 'Из истории «Свободный вечер»',
  'Сбросить эскиз', 'localStorage.removeItem', 'pointerdown', 'pointermove',
  'wheel', 'Добавить на карту', 'prefers-reduced-motion'
];
for (const text of must) {
  if (!source.includes(text)) throw new Error(`walk smoke: missing ${text}`);
}
if (source.includes('localStorage.clear(')) throw new Error('walk smoke: destructive storage reset');
const script = source.match(/<script>([\s\S]*)<\/script>/)?.[1];
if (!script) throw new Error('walk smoke: inline script not found');
new Function(script);
console.log('WALK SMOKE PASS: isolated keys, map gestures, all story exits, local notes and safe reset.');
