/**
 * First-run setup scenes (AC-B05): credentials → default model → appearance,
 * plus the one-time welcome outro.
 *
 * A scene answers "recorded" when the user explicitly finished or skipped it and
 * "deferred" when they backed out of a chooser, which resumes the scene on the
 * next launch. Scene code only talks to `SetupSceneHost`, so the orchestrator in
 * `startup-ui.ts` owns the TUI lifecycle, settings persistence, and the model
 * runtime it creates once for the whole run.
 */
import type { Api, AuthEvent, AuthPrompt, Model } from "@earendil-works/pi-ai";
import { type Component, Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { APP_NAME, getAuthPath, getDocsPath, getModelsPath } from "../config.ts";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import { AUTH_DIR_MODE, AUTH_FILE_MODE } from "../core/auth-storage.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { DynamicBorder } from "../modes/interactive/components/dynamic-border.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import { LoginDialogComponent } from "../modes/interactive/components/login-dialog.ts";
import { ModelSelectorComponent } from "../modes/interactive/components/model-selector.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "../modes/interactive/components/oauth-selector.ts";
import { buildLoginProviderOptions } from "../modes/interactive/login-providers.ts";
import { SYSTEM_THEME_NAME } from "../modes/interactive/theme/system-theme.ts";
import { getTerminalTheme, resolveThemeSetting, setTheme, theme } from "../modes/interactive/theme/theme.ts";
import { stripBom } from "../utils/text.ts";
import type { SetupSceneId } from "./setup-wizard.ts";

/** What a scene decided, and therefore whether the wizard may stamp its completion. */
export type SetupSceneOutcome = "recorded" | "deferred";

/** Services a scene may use; the orchestrator supplies the shared TUI and runtime. */
export interface SetupSceneHost {
	readonly ui: TUI;
	readonly settingsManager: SettingsManager;
	/** Created once per wizard run; `ModelRuntime.create()` performs no network I/O. */
	createModelRuntime(): Promise<ModelRuntime>;
}

type SetupComponent = Component & { dispose?(): void };

/**
 * Add `component` to the startup TUI, focus it, and return an idempotent release that
 * removes it, disposes it, and restores focus (to `restoreFocusTo` for nested prompts).
 */
function mount(host: SetupSceneHost, component: SetupComponent, restoreFocusTo?: Component | null): () => void {
	let unmounted = false;
	host.ui.addChild(component);
	host.ui.setFocus(component);
	host.ui.requestRender();
	return () => {
		if (unmounted) return;
		unmounted = true;
		host.ui.removeChild(component);
		component.dispose?.();
		host.ui.setFocus(restoreFocusTo ?? null);
		host.ui.requestRender();
	};
}

/**
 * Mount a component until it settles: `build` receives the resolver its callbacks call,
 * and the component is torn down (restoring focus) before the promise resolves.
 */
function runComponent<T>(
	host: SetupSceneHost,
	build: (settle: (value: T) => void) => SetupComponent,
	restoreFocusTo?: Component | null,
): Promise<T> {
	return new Promise<T>((resolve) => {
		let unmount: (() => void) | undefined;
		let settled = false;
		const settle = (value: T) => {
			if (settled) return;
			settled = true;
			unmount?.();
			resolve(value);
		};
		const component = build(settle);
		unmount = mount(host, component, restoreFocusTo);
		if (settled) unmount();
	});
}

/** Menu of plain labels; resolves `undefined` on cancel. */
function chooseOption(
	host: SetupSceneHost,
	title: string,
	options: readonly string[],
	description?: string,
): Promise<string | undefined> {
	return runComponent<string | undefined>(
		host,
		(settle) =>
			new ExtensionSelectorComponent(
				title,
				[...options],
				(option) => settle(option),
				() => settle(undefined),
				{ description },
			),
	);
}

/** One-line text prompt; resolves `undefined` on cancel, otherwise the trimmed value. */
function promptText(
	host: SetupSceneHost,
	title: string,
	placeholder?: string,
	description?: string,
): Promise<string | undefined> {
	return runComponent<string | undefined>(
		host,
		(settle) =>
			new ExtensionInputComponent(
				title,
				placeholder,
				(value) => settle(value.trim()),
				() => settle(undefined),
				{ description },
			),
	);
}

/** Blocking notice the user dismisses with one key press. */
function showNotice(host: SetupSceneHost, title: string, message: string): Promise<void> {
	return runComponent<undefined>(host, (settle) => {
		const selector = new ExtensionSelectorComponent(
			title,
			["Back"],
			() => settle(undefined),
			() => settle(undefined),
			{
				description: message,
			},
		);
		return selector;
	}).then(() => undefined);
}

const CREDENTIAL_MENU_OPTIONS = [
	"Sign in with OAuth",
	"Use an API key",
	"Connect a local or custom endpoint",
	"Set up later",
] as const;

/** AC-C03/C04: the four credential exits, looping back to the menu on sub-flow cancel. */
async function runCredentialsScene(host: SetupSceneHost): Promise<SetupSceneOutcome> {
	const runtime = await host.createModelRuntime();
	for (;;) {
		const choice = await chooseOption(
			host,
			"Set up credentials",
			CREDENTIAL_MENU_OPTIONS,
			"Pi calls model providers with stored credentials. Change this later with /login.",
		);
		if (choice === undefined) return "deferred";
		if (choice === "Set up later") return "recorded";

		const authType = choice === "Sign in with OAuth" ? "oauth" : choice === "Use an API key" ? "api_key" : undefined;
		if (authType === undefined) {
			await runLocalEndpointScene(host, runtime);
			continue;
		}
		const result = await runProviderLoginScene(host, runtime, authType);
		if (result === "recorded") return "recorded";
	}
}

/** Provider chooser plus the login flow for one auth method; cancel returns to the menu. */
async function runProviderLoginScene(
	host: SetupSceneHost,
	runtime: ModelRuntime,
	authType: "oauth" | "api_key",
): Promise<SetupSceneOutcome> {
	const options = buildLoginProviderOptions(runtime, authType);
	if (options.length === 0) {
		await showNotice(
			host,
			"No providers",
			authType === "oauth" ? "No OAuth providers are available." : "No API-key providers are available.",
		);
		return "deferred";
	}
	const selected = await runComponent<AuthSelectorProvider | undefined>(
		host,
		(settle) =>
			new OAuthSelectorComponent(
				"login",
				options,
				(providerId, selectedAuthType) =>
					settle(options.find((option) => option.id === providerId && option.authType === selectedAuthType)),
				() => settle(undefined),
			),
	);
	if (!selected) return "deferred";

	if (selected.authType === "api_key" && !selected.method?.login) {
		// Ambient-only providers (env vars, cloud profiles) are configured outside pi.
		await runComponent<undefined>(host, (settle) => {
			const dialog = new LoginDialogComponent(
				host.ui,
				selected.id,
				() => settle(undefined),
				selected.name,
				`${selected.name} setup`,
			);
			dialog.showInfo(
				`${selected.method?.name ?? "Authentication"} is configured outside ${APP_NAME}. ` +
					`See ${join(getDocsPath(), "providers.md")}, set it up with your provider, then continue.`,
				[],
				true,
			);
			return dialog;
		});
		return "deferred";
	}

	const disclosure =
		selected.authType === "api_key"
			? [
					theme.fg("text", `${selected.name}: enter the API key to store it for ${APP_NAME}.`),
					theme.fg("muted", `Stored in: ${getAuthPath()}`),
					theme.fg(
						"muted",
						`File mode ${AUTH_FILE_MODE.toString(8)}, directory mode ${AUTH_DIR_MODE.toString(8)} (owner only).`,
					),
					theme.fg("muted", "Never written to environment variables."),
					theme.fg("muted", "Set the provider's environment variable instead if you prefer not to store it."),
				]
			: undefined;
	const result = await runLoginFlow(host, runtime, selected, disclosure);
	if (result.status === "success") return "recorded";
	if (result.status === "failed") {
		await showNotice(host, "Login failed", result.message);
	}
	return "deferred";
}

type LoginResult = { status: "success" } | { status: "cancelled" } | { status: "failed"; message: string };

/**
 * Drive `ModelRuntime.login` on a mounted login dialog. Prompts and auth events render on
 * the dialog; a `select` prompt mounts a nested chooser that restores focus to it.
 */
async function runLoginFlow(
	host: SetupSceneHost,
	runtime: ModelRuntime,
	provider: AuthSelectorProvider,
	disclosure?: readonly string[],
): Promise<LoginResult> {
	const dialog = new LoginDialogComponent(
		host.ui,
		provider.id,
		() => {
			// Completion is observed through the login promise; the dialog only reports cancel.
		},
		provider.name,
		`${provider.name} setup`,
	);
	const unmount = mount(host, dialog);
	try {
		if (disclosure) dialog.showDetails([...disclosure]);
		await runtime.login(
			provider.id,
			provider.authType,
			{
				signal: dialog.signal,
				prompt: (prompt) => respondToAuthPrompt(host, dialog, prompt),
				notify: (event) => notifyAuthDialog(dialog, event),
			},
			{ getDeviceId: () => host.settingsManager.getOrCreateDeviceId() },
		);
		return { status: "success" };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return message === "Login cancelled" ? { status: "cancelled" } : { status: "failed", message };
	} finally {
		unmount();
	}
}

function respondToAuthPrompt(host: SetupSceneHost, dialog: LoginDialogComponent, prompt: AuthPrompt): Promise<string> {
	const response =
		prompt.type === "select"
			? runComponent<string | undefined>(
					host,
					(settle) =>
						new ExtensionSelectorComponent(
							prompt.message,
							prompt.options.map((option) => option.label),
							(label) => settle(prompt.options.find((option) => option.label === label)?.id),
							() => settle(undefined),
						),
					dialog,
				).then((id) => {
					if (!id) throw new Error("Login cancelled");
					return id;
				})
			: prompt.type === "manual_code"
				? dialog.showManualInput(prompt.message)
				: dialog.showPrompt(prompt.message, prompt.placeholder);

	if (!prompt.signal) return response;
	if (prompt.signal.aborted) return Promise.reject(new Error("Login cancelled"));
	const signal = prompt.signal;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<string>((_resolve, reject) => {
		onAbort = () => reject(new Error("Login cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([response, aborted]).finally(() => {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	});
}

function notifyAuthDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
	if (event.type === "auth_url") {
		dialog.showAuth(event.url, event.instructions);
	} else if (event.type === "device_code") {
		dialog.showDeviceCode(event);
		dialog.showWaiting("Waiting for authentication...");
	} else if (event.type === "info") {
		dialog.showInfo(event.message, event.links);
	} else {
		dialog.showProgress(event.message);
	}
}

/**
 * AC-C04 exit 3: register an OpenAI-compatible endpoint in `models.json`
 * (docs/models.md: "Configure a compatible endpoint"). A blank key becomes a dummy key so
 * the provider resolves without any credential.
 */
async function runLocalEndpointScene(host: SetupSceneHost, runtime: ModelRuntime): Promise<void> {
	const baseUrl = await promptText(
		host,
		"Base URL of the OpenAI-compatible endpoint",
		"http://localhost:11434/v1",
		"Works with Ollama, LM Studio, vLLM, SGLang, and other compatible servers.",
	);
	if (baseUrl === undefined) return;
	if (!/^https?:\/\/\S+$/i.test(baseUrl)) {
		await showNotice(host, "Invalid base URL", "The base URL must start with http:// or https://.");
		return;
	}

	const providerId = await promptText(
		host,
		"Provider id for this endpoint",
		"local",
		"Lowercase letters, digits, and dashes.",
	);
	if (providerId === undefined) return;
	if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId)) {
		await showNotice(
			host,
			"Invalid provider id",
			"Use lowercase letters, digits, and dashes, starting with a letter or digit.",
		);
		return;
	}

	const modelId = await promptText(
		host,
		"Model id served by the endpoint",
		undefined,
		"Exactly the id the endpoint expects.",
	);
	if (modelId === undefined) return;
	if (!modelId) {
		await showNotice(host, "Missing model id", "The model id must not be empty.");
		return;
	}

	const apiKey = await promptText(
		host,
		"API key (optional)",
		undefined,
		"Leave empty if the endpoint needs no key; Pi then stores a dummy key.",
	);
	if (apiKey === undefined) return;

	try {
		writeLocalEndpointProvider({ baseUrl, providerId, modelId, apiKey });
		// Pick the new provider up before the model scene lists candidates.
		await runtime.refresh();
	} catch (error: unknown) {
		await showNotice(host, "Could not update models.json", error instanceof Error ? error.message : String(error));
	}
}

/** Merge one provider entry into `models.json`, preserving the rest of the file. */
export function writeLocalEndpointProvider(entry: {
	baseUrl: string;
	providerId: string;
	modelId: string;
	apiKey: string;
}): void {
	const modelsPath = getModelsPath();
	let config: Record<string, unknown> = {};
	if (existsSync(modelsPath)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripBom(readFileSync(modelsPath, "utf-8")));
		} catch {
			throw new Error(`${modelsPath} is not valid JSON; fix it before adding an endpoint.`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`${modelsPath} must contain a JSON object.`);
		}
		config = parsed as Record<string, unknown>;
	}
	const existingProviders =
		typeof config.providers === "object" && config.providers !== null && !Array.isArray(config.providers)
			? (config.providers as Record<string, unknown>)
			: {};
	const existingProvider = existingProviders[entry.providerId];
	const provider =
		typeof existingProvider === "object" && existingProvider !== null && !Array.isArray(existingProvider)
			? (existingProvider as Record<string, unknown>)
			: {};
	const existingModels = Array.isArray(provider.models) ? (provider.models as unknown[]) : [];
	const models = [
		...existingModels.filter(
			(model) => typeof model === "object" && model !== null && (model as { id?: string }).id !== entry.modelId,
		),
		{ id: entry.modelId },
	];
	existingProviders[entry.providerId] = {
		...provider,
		baseUrl: entry.baseUrl,
		api: "openai-completions",
		apiKey: entry.apiKey || "local",
		models,
	};
	config.providers = existingProviders;
	const directory = dirname(modelsPath);
	if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: AUTH_DIR_MODE });
	writeFileSync(modelsPath, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
}

/** AC-C05: credential-filtered model chooser; empty catalogs get the login guidance. */
async function runModelScene(host: SetupSceneHost): Promise<SetupSceneOutcome> {
	const runtime = await host.createModelRuntime();
	try {
		// Refresh the availability snapshot so models unlocked by the credentials scene show up.
		await runtime.getAvailable();
	} catch {
		// Offline or failing catalogs: the snapshot below degrades to what is known locally.
	}
	if (runtime.getAvailableSnapshot().length === 0) {
		const choice = await chooseOption(
			host,
			"Choose a default model",
			["Continue without choosing a model"],
			formatNoModelsAvailableMessage(),
		);
		return choice === undefined ? "deferred" : "recorded";
	}

	const selected = await runComponent<Model<Api> | undefined>(
		host,
		(settle) =>
			new ModelSelectorComponent(
				host.ui,
				undefined,
				runtime,
				[],
				(model) => settle(model),
				() => settle(undefined),
			),
	);
	if (!selected) return "deferred";
	host.settingsManager.setDefaultModelAndProvider(selected.provider, selected.id);
	await host.settingsManager.flush();
	return "recorded";
}

/**
 * Appearance scene reuses the original first-time setup dialog. Both outcomes record the
 * scene: submit saves the choices, and cancel is labeled "skip setup" in the dialog.
 */
async function runAppearanceScene(host: SetupSceneHost): Promise<SetupSceneOutcome> {
	const result = await runComponent<FirstTimeSetupResult | undefined>(
		host,
		(settle) =>
			new FirstTimeSetupComponent({
				onThemePreview: (themeName) => {
					setTheme(themeName);
					host.ui.requestRender();
				},
				onSubmit: (setupResult) => settle(setupResult),
				onCancel: () => settle(undefined),
			}),
	);
	if (result) {
		host.settingsManager.setTheme(result.theme);
		host.settingsManager.setEnableAnalytics(result.shareAnalytics);
	} else {
		// Discard an unsubmitted preview so settings keep the configured theme.
		setTheme(resolveThemeSetting(host.settingsManager.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME);
	}
	await host.settingsManager.flush();
	return "recorded";
}

export async function runSetupScene(id: SetupSceneId, host: SetupSceneHost): Promise<SetupSceneOutcome> {
	switch (id) {
		case "credentials":
			return runCredentialsScene(host);
		case "model":
			return runModelScene(host);
		case "appearance":
			return runAppearanceScene(host);
		default: {
			const _exhaustive: never = id;
			return "deferred";
		}
	}
}

class WelcomeOutroComponent extends Container {
	private readonly onDone: () => void;

	constructor(onDone: () => void) {
		super();
		this.onDone = onDone;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Setup complete.")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"text",
					`Useful commands: /help, /login to change credentials, /model to switch models, /theme for appearance.`,
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "Press any key to continue"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(_data: string): void {
		this.onDone();
	}
}

/** One-time outro shown after every owed scene was recorded and completion stamped. */
export function runWelcomeOutro(host: SetupSceneHost): Promise<void> {
	return runComponent<undefined>(host, (settle) => new WelcomeOutroComponent(() => settle(undefined))).then(
		() => undefined,
	);
}
