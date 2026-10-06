import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { formatNoModelsAvailableMessage } from "../../../core/auth-guidance.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { formatModelCandidateMeta, isSubscriptionBackedProvider } from "../model-candidate-meta.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import {
	buildCatalogEntries,
	type CatalogEntry,
	type CatalogFilter,
	catalogSearchText,
	matchesCatalogFilter,
	parseCatalogQuery,
	summarizeCatalog,
} from "../model-catalog-view.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText, keyHint } from "./keybinding-hints.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
	/** Catalog rows carry their browse facets so filtering never re-derives them. */
	entry?: CatalogEntry;
}

/** Model ids are unique per type but not per catalog, so the type is part of the key. */
function catalogEntryKey(entry: CatalogEntry): string {
	return `${entry.modelType}\0${entry.provider}\0${entry.id}`;
}

function toCatalogEntry(item: ModelItem): CatalogEntry {
	if (item.entry) return item.entry;
	const model = item.model;
	return {
		model: model as never,
		provider: model.provider,
		id: model.id,
		name: model.name,
		modelType: "chat",
		api: model.api,
		inputCost: model.cost.input,
		outputCost: model.cost.output,
		contextWindow: model.contextWindow,
		reasoning: model.reasoning,
		images: model.input.includes("image"),
	};
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

interface DefaultModelReference {
	provider: string;
	id: string;
}

/**
 * `catalog` is the whole generated catalog, credential filtering off, so a user can
 * look up a model before logging into a second provider. It is a third scope rather
 * than the default because AC-C05 requires `/model` to lead with what the current
 * credentials can actually use.
 */
type ModelScope = "all" | "scoped" | "catalog";

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private catalogModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	/** Applied on top of the fuzzy match while the `catalog` scope is active. */
	private catalogFilter: CatalogFilter = {};
	private catalogEntries: CatalogEntry[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private modelRuntime: ModelRuntime;
	private onSelectCallback: (model: Model<any>) => void;
	private onSelectAsDefaultCallback?: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private defaultModel?: DefaultModelReference;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (model: Model<any>) => void,
		defaultModel?: DefaultModelReference,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.defaultModel = defaultModel;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// The scope switcher is always shown: the catalog scope is reachable even with
		// nothing scoped, so hiding the switcher would make it undiscoverable.
		this.scopeText = new Text(this.getScopeText(), 0, 0);
		this.addChild(this.scopeText);
		this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
		this.addChild(this.scopeHintText);
		const hintText = "Only showing models from configured providers. Use /login to add providers.";
		this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Hint
		if (this.onSelectAsDefaultCallback) {
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						`  ${keyDisplayText("tui.select.confirm")} to select · ${keyDisplayText("app.models.save")} to set as default · ${keyDisplayText("tui.select.cancel")} to cancel`,
					),
					0,
					0,
				),
			);
		}

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Render the current snapshot immediately, then refresh in the background.
		this.loadModelsFromSnapshot();
		if (initialSearchInput) this.filterModels(initialSearchInput);
		else this.updateList();
		this.tui.requestRender();
		void this.refreshModels();
	}

	private loadModelsFromSnapshot(): void {
		const models = this.modelRuntime.getAvailableSnapshot().map((model: Model<any>) => ({
			provider: model.provider,
			id: model.id,
			model,
		}));
		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.catalogEntries = buildCatalogEntries(this.modelRuntime.getAllModels());
		this.catalogModelItems = this.catalogEntries.map((entry) => ({
			provider: entry.provider,
			id: entry.id,
			model: entry.model as Model<any>,
			entry,
		}));
		this.activeModels = this.activeScopeModels();
		this.filteredModels = this.activeModels;
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private async refreshModels(): Promise<void> {
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			const result = await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				this.errorMessage = this.modelRuntime.getError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			this.loadModelsFromSnapshot();
			this.filterModels(this.searchInput.getValue());
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.refreshStatusMessage = "";
			this.errorMessage = timedOut
				? "Model refresh timed out; showing cached models."
				: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			this.updateList();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// Sort: current model first, default model second, then by provider.
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			const aIsDefault = this.isDefaultModel(a.model);
			const bIsDefault = this.isDefaultModel(b.model);
			if (aIsDefault && !bIsDefault) return -1;
			if (!aIsDefault && bIsDefault) return 1;
			return a.provider.localeCompare(b.provider);
		});
		return sorted;
	}

	/** Scope cycle order for the tab key. `scoped` is skipped when nothing is scoped. */
	private scopeOrder(): ModelScope[] {
		return this.scopedModelItems.length > 0 ? ["all", "scoped", "catalog"] : ["all", "catalog"];
	}

	private activeScopeModels(): ModelItem[] {
		if (this.scope === "scoped") return this.scopedModelItems;
		if (this.scope === "catalog") return this.catalogModelItems;
		return this.allModels;
	}

	private getScopeText(): string {
		const label = (scope: ModelScope): string =>
			this.scope === scope ? theme.fg("accent", scope) : theme.fg("muted", scope);
		return `${theme.fg("muted", "Scope: ")}${this.scopeOrder().map(label).join(theme.fg("muted", " | "))}`;
	}

	private getScopeHintText(): string {
		const scopes = this.scopeOrder().join("/");
		const suffix =
			this.scope === "catalog"
				? theme.fg("muted", " · filters: provider: api: type: images reasoning free under: ctx:")
				: "";
		return keyHint("tui.input.tab", "scope") + theme.fg("muted", ` (${scopes})`) + suffix;
	}

	private isDefaultModel(model: Model<any>): boolean {
		return this.defaultModel?.provider === model.provider && this.defaultModel.id === model.id;
	}

	private isDefaultSearch(query: string): boolean {
		const normalized = query.trim().toLowerCase();
		return normalized.length > 0 && "default".startsWith(normalized);
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.activeScopeModels();
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		// The two scopes speak different query languages: the catalog scope reads facets
		// (`provider:groq`), the credential-backed scopes read a bare fuzzy term. Carrying a
		// query across would leave `provider:groq` matching nothing on the other side, so
		// the input is reset and the scope starts unfiltered.
		this.searchInput.setValue("");
		this.filterModels("");
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
		if (this.scopeHintText) {
			this.scopeHintText.setText(this.getScopeHintText());
		}
	}

	/**
	 * Narrow the active scope. In the catalog scope the query doubles as a filter
	 * language (`provider:groq ctx:1m`), so the facets are parsed out and applied
	 * before the remaining text goes to the fuzzy matcher.
	 */
	private filterModels(query: string): void {
		if (this.scope === "catalog") {
			this.filterCatalog(query);
			return;
		}
		this.catalogFilter = {};
		if (query) {
			const filtered = fuzzyFilter(this.activeModels, query, (item) => {
				const defaultText = this.isDefaultModel(item.model) ? " default" : "";
				return `${getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.model.name })}${defaultText}`;
			});
			if (this.isDefaultSearch(query)) {
				const defaultItems = this.activeModels.filter((item) => this.isDefaultModel(item.model));
				const defaultKeys = new Set(defaultItems.map((item) => `${item.provider}\0${item.id}`));
				this.filteredModels = [
					...defaultItems,
					...filtered.filter((item) => !defaultKeys.has(`${item.provider}\0${item.id}`)),
				];
			} else {
				this.filteredModels = filtered;
			}
		} else {
			this.filteredModels = this.activeModels;
		}
		// When filtering by a query, move the selector to the top row so the best
		// match is highlighted. When the query is cleared, keep the current position
		// clamped to the (restored) list length.
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private filterCatalog(query: string): void {
		const parsed = parseCatalogQuery(query);
		this.catalogFilter = parsed.filter;
		const allowed = new Set(
			this.catalogEntries.filter((entry) => matchesCatalogFilter(entry, parsed.filter)).map(catalogEntryKey),
		);
		const candidates = this.catalogModelItems.filter((item) => allowed.has(catalogEntryKey(toCatalogEntry(item))));
		this.filteredModels = parsed.text
			? fuzzyFilter(candidates, parsed.text, (item) => catalogSearchText(toCatalogEntry(item)))
			: candidates;
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	/**
	 * Row annotation. The catalog scope answers a lookup question, so it reports the
	 * transport api, model type, and price; the credential-backed scopes keep the
	 * AC-C05 billing annotation, which is about what the current subscription covers.
	 */
	private formatRowMeta(item: ModelItem): string {
		if (this.scope !== "catalog") {
			return theme.fg(
				"muted",
				` · ${formatModelCandidateMeta(item.model, {
					subscription: isSubscriptionBackedProvider(this.modelRuntime, item.provider),
				})}`,
			);
		}
		const entry = toCatalogEntry(item);
		const bits = [entry.api, entry.modelType === "chat" ? undefined : entry.modelType];
		if (entry.reasoning) bits.push("reasoning");
		if (entry.images) bits.push("images");
		bits.push(entry.inputCost === 0 && entry.outputCost === 0 ? "free" : `$${entry.inputCost}/$${entry.outputCost}`);
		return theme.fg("muted", ` · ${bits.filter(Boolean).join(" · ")}`);
	}

	/**
	 * Facet counts for the current result set. An empty result set reports zero rather
	 * than an empty range, so the line explains the miss instead of rendering blanks.
	 */
	private catalogSummaryLines(): Text[] {
		const matching = this.catalogEntries.filter((entry) => matchesCatalogFilter(entry, this.catalogFilter));
		const summary = summarizeCatalog(matching);
		const price =
			summary.minInputCost === summary.maxInputCost
				? `$${summary.minInputCost}/M in`
				: `$${summary.minInputCost}-$${summary.maxInputCost}/M in`;
		return [
			new Text(theme.fg("muted", `  ${matching.length} models`), 0, 0),
			new Text(
				theme.fg(
					"muted",
					`  ${summary.providers} providers · ${summary.apis} apis · ${price} · ${summary.images} with images · ${summary.reasoning} reasoning · ${summary.free} free`,
				),
				0,
				0,
			),
		];
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const isDefault = this.isDefaultModel(item.model);
			const defaultBadge = isDefault ? theme.fg("muted", " · default") : "";

			const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
			const currentMarker = isCurrent ? theme.fg("accent", "✓ ") : "  ";
			const modelText = isSelected ? theme.fg("accent", item.id) : item.id;
			const providerBadge = theme.fg("muted", `[${item.provider}]`);
			const line = `${cursor}${currentMarker}${modelText} ${providerBadge}${this.formatRowMeta(item)}${defaultBadge}`;

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		if (this.scope === "catalog") {
			this.listContainer.addChild(new Spacer(1));
			for (const line of this.catalogSummaryLines()) {
				this.listContainer.addChild(line);
			}
		}

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			// No credential-backed models at all: guide to /login instead of a dead end (AC-C05).
			// The catalog scope never shows that guidance; an empty result there means the
			// query was too narrow, and /login would not help.
			if (this.scope === "catalog") {
				this.listContainer.addChild(new Text(theme.fg("muted", "  No catalog models match this query"), 0, 0));
			} else if (this.activeModels.length === 0) {
				for (const guidanceLine of formatNoModelsAvailableMessage().split("\n")) {
					this.listContainer.addChild(new Text(theme.fg("muted", `  ${guidanceLine}`), 0, 0));
				}
			} else {
				this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			}
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
		}
		if (this.refreshStatusMessage) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.input.tab")) {
			const order = this.scopeOrder();
			const next = order[(order.indexOf(this.scope) + 1) % order.length];
			this.setScope(next);
			return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.dispose();
			this.onCancelCallback();
		}
		// Select and save as default
		else if (kb.matches(keyData, "app.models.save") && this.onSelectAsDefaultCallback) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.dispose();
				this.onSelectAsDefaultCallback(selectedModel.model);
			}
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<any>): void {
		this.dispose();
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
