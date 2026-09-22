/**
 * End / intervention alerts: OS toast channels + BEL (host tab bell side-effect).
 * Aligned with official examples/extensions/notify.ts; never put alarm emoji into titles.
 */

import { execFile } from "node:child_process";
import type { SoundLevel } from "./types.ts";

function windowsToastScript(title: string, body: string): string {
	const safeTitle = title.replace(/'/g, "''");
	const safeBody = body.replace(/'/g, "''");
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${safeBody}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${safeTitle}').Show(${toast})`,
	].join("; ");
}

export function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

export function notifyOSC99(title: string, body: string): void {
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

export function notifyWindows(title: string, body: string): void {
	execFile(
		"powershell.exe",
		["-NoProfile", "-Command", windowsToastScript(title, body)],
		{ windowsHide: true },
		() => {
			/* best-effort */
		},
	);
}

/** Pick channel from environment (WT / Kitty / OSC 777 default). */
export function osNotify(title: string, body: string): void {
	try {
		if (process.env.WT_SESSION) {
			notifyWindows(title, body);
		} else if (process.env.KITTY_WINDOW_ID) {
			notifyOSC99(title, body);
		} else {
			notifyOSC777(title, body);
		}
	} catch {
		/* swallow */
	}
}

/** L1 BEL — host may draw a tab bell badge (e.g. Windows Terminal). */
export function bel(): void {
	try {
		process.stdout.write("\x07");
	} catch {
		/* swallow */
	}
}

/** Best-effort system beep (L2). */
export function systemBeep(): void {
	try {
		if (process.platform === "win32") {
			execFile(
				"powershell.exe",
				["-NoProfile", "-Command", "[console]::beep(800,120)"],
				{ windowsHide: true },
				() => {},
			);
		} else {
			bel();
		}
	} catch {
		/* swallow */
	}
}

export function playSound(level: SoundLevel): void {
	if (level === "system") {
		bel();
		systemBeep();
		return;
	}
	// file level falls back to BEL without a configured path
	bel();
}
