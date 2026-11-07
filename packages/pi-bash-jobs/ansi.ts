/**
 * ANSI escape stripping for the job log tee (doc 37 §1.3 的落盘口径).
 *
 * The ring keeps raw bytes — the model's inspect output and snapshot tails behave exactly as
 * before. Only the tee strips escape sequences, so a curl/pip progress bar lands in the log as
 * whole text lines instead of cursor-movement noise PiDesk's tail would render literally.
 */

// CSI: ESC [ <params 0-9:;<=>?> <intermediates " -/"> <final @-~>
const CSI_PATTERN = /\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/g;
// OSC: ESC ] ... terminated by BEL or ST (ESC \)
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Leftover C0 controls other than \n and \t (BEL, NUL, backspace…). \r never reaches a tee:
// the ring commits on \r too, so lines are already split.
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsi(line: string): string {
	return line.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}
