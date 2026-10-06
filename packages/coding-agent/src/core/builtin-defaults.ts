/** Built-in resources shipped with pi. User/project resources have precedence. */
export const BUILTIN_DEFAULTS_DIRECTORY = "assets/builtin-defaults";

export interface BuiltinDefaultsSettings {
	builtinRules: boolean;
	builtinSkills: boolean;
	builtinPrompts: boolean;
}

export const DEFAULT_BUILTIN_DEFAULTS_SETTINGS: BuiltinDefaultsSettings = {
	builtinRules: true,
	builtinSkills: true,
	builtinPrompts: true,
};

export const BUILTIN_DEFAULT_RULES = [
	{
		name: "safe-review",
		description: "Inspect relevant files and tests before changing behavior.",
		content:
			"Read the relevant files and tests first. Make the smallest focused change and run the narrowest useful check.",
	},
] as const;
