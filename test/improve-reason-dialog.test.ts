import test from 'node:test';
import assert from 'node:assert/strict';
import {ImproveReasonDialog,RESTORE_REASONS} from '../src/tui/improve-management.js';

test('reason note renders the public input cursor after insertion in the middle',()=>{
 const dialog=new ImproveReasonDialog({title:'恢复建议',action:'恢复'},RESTORE_REASONS);
 dialog.handleInput('\t');dialog.handleInput('abc');dialog.handleInput('\x1b[D');dialog.handleInput('\x1b[D');dialog.handleInput('X');
 assert.equal(dialog.note,'aXbc');
 assert.match(dialog.render(132,38).join('\n'),/aX\x1b\[7mb/,'cursor must highlight b immediately after inserted X');
});
