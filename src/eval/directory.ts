import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

/** Parent is new; the runner creates the child exclusively. */
export async function newEvalDirectory(){return join(await mkdtemp(join(tmpdir(),'pi-durio-eval-')),'batch');}
