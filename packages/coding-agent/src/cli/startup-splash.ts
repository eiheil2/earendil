/**
 * Startup splash: a short brand frame shown before the setup scenes (AC-B06).
 *
 * Rendering is ANSI-only: pi-tui has no native render path, so the omp splash's
 * native branch has nothing to port to. Any key skips the splash early.
 */
import type { Component, TUI } from "@earendil-works/pi-tui";
import { APP_NAME, VERSION } from "../config.ts";
import { piLogoLines, piWordmark, supportsPiLogo } from "../modes/interactive/components/pi-logo.ts";
import { theme } from "../modes/interactive/theme/theme.ts";

/** Inputs used to decide whether the startup splash may run for this process. */
export interface StartupSplashDecisionOptions {
	readonly configured: boolean;
	readonly isInteractive: boolean;
	readonly resuming: boolean;
	readonly quiet: boolean;
	readonly timing: boolean;
	readonly stdinIsTTY: boolean | undefined;
	readonly stdoutIsTTY: boolean | undefined;
}

/** Returns true only for enabled, non-quiet, interactive TTY startup. */
export function shouldShowStartupSplash(options: StartupSplashDecisionOptions): boolean {
	if (!options.configured) return false;
	if (!options.isInteractive) return false;
	if (options.resuming || options.quiet) return false;
	if (options.timing) return false;
	return options.stdinIsTTY === true && options.stdoutIsTTY === true;
}

export interface StartupSplashOptions {
	readonly durationMs?: number;
	readonly tickMs?: number;
	readonly now?: () => number;
}

const DEFAULT_SPLASH_MS = 1600;
const DEFAULT_TICK_MS = 50;

class StartupSplashComponent implements Component {
	private readonly durationMs: number;
	private readonly tickMs: number;
	private readonly now: () => number;
	private readonly tui: TUI;
	private readonly onDone: () => void;
	private startedAt = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private done = false;

	constructor(tui: TUI, onDone: () => void, options: StartupSplashOptions = {}) {
		this.tui = tui;
		this.onDone = onDone;
		this.durationMs = options.durationMs ?? DEFAULT_SPLASH_MS;
		this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
		this.now = options.now ?? (() => Date.now());
	}

	start(): void {
		this.startedAt = this.now();
		this.timer = setInterval(() => this.tick(), this.tickMs);
		this.tui.requestRender();
	}

	dispose(): void {
		this.stopTimer();
	}

	handleInput(_data: string): void {
		this.complete();
	}

	invalidate(): void {
		// Nothing cached: every frame rebuilds from the elapsed time.
	}

	render(width: number): string[] {
		const elapsed = Math.min(this.durationMs, Math.max(0, this.now() - this.startedAt));
		const lines: string[] = [];
		if (supportsPiLogo()) {
			const [top, bottom] = piLogoLines();
			lines.push(`${top} ${theme.fg("text", APP_NAME)} ${theme.fg("dim", `v${VERSION}`)}`);
			lines.push(bottom);
		} else {
			lines.push(`${piWordmark()} ${theme.fg("text", APP_NAME)} ${theme.fg("dim", `v${VERSION}`)}`);
		}
		lines.push("");

		const barWidth = Math.max(8, Math.min(32, Math.max(0, width - 4)));
		const filled = Math.round((elapsed / this.durationMs) * barWidth);
		const bar = `${theme.fg("accent", "█".repeat(filled))}${theme.fg("dim", "░".repeat(barWidth - filled))}`;
		lines.push(`  ${bar}`);
		lines.push("");
		lines.push(theme.fg("dim", "  Press any key to skip"));
		return lines;
	}

	private tick(): void {
		if (this.done) return;
		if (this.now() - this.startedAt >= this.durationMs) {
			this.complete();
			return;
		}
		this.tui.requestRender();
	}

	private complete(): void {
		if (this.done) return;
		this.done = true;
		this.stopTimer();
		this.onDone();
	}

	private stopTimer(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}
}

/** Show the splash on `ui` until it finishes, is skipped by a key, or `durationMs` elapses. */
export function runStartupSplash(ui: TUI, options: StartupSplashOptions = {}): Promise<void> {
	return new Promise((resolve) => {
		let component: StartupSplashComponent | undefined;
		const finish = () => {
			component?.dispose();
			if (component) ui.removeChild(component);
			ui.setFocus(null);
			resolve();
		};
		component = new StartupSplashComponent(ui, finish, options);
		ui.addChild(component);
		ui.setFocus(component);
		component.start();
	});
}
