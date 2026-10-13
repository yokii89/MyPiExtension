const mockTui = `
export const Key = { escape: "escape", enter: "enter", up: "up", down: "down", backspace: "backspace" };
export function matchesKey(data, key) { return data === key; }
function stripAnsi(text) { return text.replace(/\\x1B\\[[0-?]*[ -\\/]*[@-~]/g, ""); }
function charWidth(char) { const code = char.codePointAt(0) ?? 0; return (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || code >= 0x1f300 ? 2 : 1; }
export function visibleWidth(text) { return Array.from(stripAnsi(text)).reduce((width, char) => width + charWidth(char), 0); }
export function wrapTextWithAnsi(text, width) {
  const lines = []; let line = ""; let lineWidth = 0;
  for (const char of Array.from(text)) {
    const charWidthValue = charWidth(char);
    if (line && lineWidth + charWidthValue > width) { lines.push(line); line = ""; lineWidth = 0; }
    line += char; lineWidth += charWidthValue;
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}
`;

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@earendil-works/pi-tui") {
		return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(mockTui)}` };
	}
	return await nextResolve(specifier, context);
}
