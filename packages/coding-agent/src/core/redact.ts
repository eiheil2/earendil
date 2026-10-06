/**
 * Credential redaction for every pi surface a user may paste into an issue:
 * the `pi doctor` report, startup failure reports, and the structured log.
 *
 * Redaction is textual: it masks values that are already present in the text,
 * so a message that never contained a credential is returned unchanged.
 */

/** Marker written in place of a credential value. */
export const REDACTED = "[redacted]";

/** Environment variable names whose values are credentials. */
const SENSITIVE_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)/i;

/** Shortest environment value worth masking; `1`, `on`, `us` would only corrupt text. */
const MIN_ENV_VALUE_LENGTH = 8;

/** Credential shapes that appear without a name to anchor on (error text, URLs, JSON). */
const KEY_SHAPES: readonly RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{8,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{8,}\b/g,
	/\bAKIA[0-9A-Z]{12,}\b/g,
	/\bAIza[0-9A-Za-z_-]{10,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** Credentials smuggled through query strings (`?api_key=…`, `&access_token=…`). */
const QUERY_SECRET =
	/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|password|secret|auth)=)[^&\s"']+/gi;

/**
 * Credentials written as a name/value pair (`OPENAI_API_KEY=sk-…`,
 * `"githubToken": "ghp_…"`), the shape error messages and settings JSON use.
 *
 * The value must be at least 6 characters: shorter ones are counts and enum
 * words that happen to sit after a credential-shaped name (`credentials: 9`),
 * not secrets worth losing.
 */
const NAMED_SECRET =
	/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*)("?\s*[=:]\s*)(?:"([^"]{6,})"|'([^']{6,})'|([^\s,;&)]{6,}))/gi;

interface EnvCredential {
	name: string;
	value: string;
}

/** True when an environment variable name marks its value as a credential. */
export function isCredentialEnvName(name: string): boolean {
	return SENSITIVE_ENV_NAME.test(name);
}

/**
 * Names of credential-carrying environment variables currently set.
 *
 * Names only — {@link redactSecrets} is what touches values, so a report can
 * say which providers are configured without ever printing a key.
 */
export function credentialEnvNames(): string[] {
	return Object.entries(process.env)
		.filter(([name, value]) => isCredentialEnvName(name) && (value ?? "").length >= MIN_ENV_VALUE_LENGTH)
		.map(([name]) => name)
		.sort();
}

function collectEnvCredentials(): EnvCredential[] {
	const credentials: EnvCredential[] = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue;
		if (!isCredentialEnvName(name)) continue;
		credentials.push({ name, value });
	}
	// Longest first so a value that contains another (a session string inside a
	// bearer token) is masked as one unit instead of leaving a suffix behind.
	return credentials.sort((a, b) => b.value.length - a.value.length);
}

/**
 * Replace credential values in `text` with {@link REDACTED}.
 *
 * Masks environment values whose names look like credentials, well-known key
 * shapes, and query-string secrets. Never throws: an unmaskable input is
 * returned as-is rather than dropping the message the caller wanted to log.
 */
export function redactSecrets(text: string): string {
	if (text.length === 0) return text;
	let result = text;
	for (const { name, value } of collectEnvCredentials()) {
		if (!result.includes(value)) continue;
		result = result.split(value).join(`${REDACTED}:${name}`);
	}
	for (const pattern of KEY_SHAPES) {
		// Fresh lastIndex: the patterns are stateful (`g`) and reused across calls.
		pattern.lastIndex = 0;
		result = result.replace(pattern, REDACTED);
	}
	result = result.replace(QUERY_SECRET, (_match, prefix: string) => `${prefix}${REDACTED}`);
	NAMED_SECRET.lastIndex = 0;
	// Parameter order mirrors the capture groups: name, separator, then the
	// three alternatives (double-quoted, single-quoted, bare).
	result = result.replace(
		NAMED_SECRET,
		(_match, name: string, separator: string, doubleQuoted?: string, singleQuoted?: string) => {
			// Keep the original quoting so a redacted JSON line stays parseable.
			// Optional groups capture "" when they matched nothing, not undefined.
			if (doubleQuoted) return `${name}${separator}"${REDACTED}"`;
			if (singleQuoted) return `${name}${separator}'${REDACTED}'`;
			return `${name}${separator}${REDACTED}`;
		},
	);
	return result;
}
