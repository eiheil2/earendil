/**
 * Syntax probe helpers.
 *
 * The OMP engine implements these with tree-sitter (`pi_ast`). The
 * unified pi repo has no tree-sitter runtime, so the probe is
 * unavailable: `parsesCleanly` currently reports "unknown" via `false`
 * and the node-chain/boundary queries return empty. Callers that depend
 * on a positive parse probe (boundary-repair, landing-shift, block
 * locators) therefore stay on their conservative paths; see
 * PHASE2-HASHLINE.md for the parity impact.
 */

export interface NodeSpan {
	kind: string;
	start_line: number;
	end_line: number;
}

export function nodeChain(_lines: string[], _path: string, _line: number): NodeSpan[] {
	return [];
}

export function enclosingBoundaries(_lines: string[], _path: string, _start: number, _end: number): number[] {
	return [];
}

export function parsesCleanly(_path: string | undefined, _text: string): boolean {
	return false;
}
