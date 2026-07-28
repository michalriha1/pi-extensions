export const EXPLORATION_BUILT_INS = new Set(["read", "grep", "find", "ls"]);

/** Model-written field injected into owned tool schemas by `intent.ts`. */
export const INTENT_KIND_FIELD = "intentKind";
export const INTENT_TEXT_FIELD = "intentText";
export const INTENT_GROUP_FIELD = "intentGroup";
export const INTENT_GROUP_TEXT_FIELD = "intentGroupText";
export const INTENT_COMMAND_CHARACTER_LIMIT = 20;
export const INTENT_KINDS = ["explore", "modify"] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

export const PI_WEB_ACCESS_TOOLS = new Set(["web_search", "fetch_content", "get_search_content"]);
export const SHELL_TOOL_NAMES = new Set(["bash", "hypa_shell"]);
export const EASY_MOTION_ALPHABET = "asdfghjklqwertyuiopzxcvbnm";

export function generateSelectionLabels(count: number): string[] {
	if (count <= 0) return [];
	const base = EASY_MOTION_ALPHABET.length;
	let width = 1;
	while (base ** width < count) width += 1;
	return Array.from({ length: count }, (_, index) => {
		let value = index;
		let label = "";
		for (let position = 0; position < width; position += 1) {
			label = `${EASY_MOTION_ALPHABET[value % base]}${label}`;
			value = Math.floor(value / base);
		}
		return label;
	});
}

const RETRIEVAL_VERBS = new Set([
	"read",
	"get",
	"list",
	"search",
	"find",
	"fetch",
	"retrieve",
	"lookup",
	"describe",
	"query",
]);

const BLOCKED_VERBS = new Set([
	"auth",
	"authenticate",
	"connect",
	"disconnect",
	"reconnect",
	"login",
	"logout",
	"create",
	"add",
	"append",
	"insert",
	"replace",
	"upsert",
	"update",
	"edit",
	"write",
	"delete",
	"remove",
	"set",
	"post",
	"put",
	"patch",
	"mutate",
	"execute",
	"run",
	"send",
	"upload",
]);

const MCP_OPERATION_KEYS = ["tool", "action", "describe", "search", "server"] as const;
const TARGET_KEYS = [
	"path",
	"file_path",
	"query",
	"pattern",
	"issue",
	"issueKey",
	"key",
	"id",
	"url",
	"target",
	"name",
	"project",
	"repository",
] as const;

const READ_ONLY_SHELL_COMMANDS = new Set([
	"[",
	"base64",
	"basename",
	"bat",
	"cat",
	"cksum",
	"cmp",
	"comm",
	"column",
	"cut",
	"date",
	"df",
	"diff",
	"dirname",
	"du",
	"echo",
	"egrep",
	"expand",
	"expr",
	"false",
	"fgrep",
	"file",
	"fold",
	"grep",
	"head",
	"hostname",
	"id",
	"jq",
	"join",
	"ls",
	"md5",
	"md5sum",
	"nl",
	"od",
	"paste",
	"printenv",
	"printf",
	"pwd",
	"read",
	"readlink",
	"realpath",
	"rev",
	"rg",
	"seq",
	"sha1sum",
	"sha256sum",
	"sha512sum",
	"shasum",
	"sort",
	"stat",
	"strings",
	"tac",
	"tail",
	"test",
	"tree",
	"tr",
	"true",
	"type",
	"uname",
	"uniq",
	"uptime",
	"wc",
	"whereis",
	"which",
	"whoami",
	"xxd",
	"zgrep",
]);

// Shell control words that never mutate state on their own. Any command that
// follows one of them is still validated recursively.
const SHELL_CONTROL_WORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "time"]);
const SHELL_BLOCK_WORDS = new Set(["done", "fi", "esac", "{", "}", "(", ")", ";;"]);
const SHELL_WORD_LIST_KEYWORDS = new Set(["for", "select", "case"]);

// Commands that unambiguously change state. They let a deterministic "mutating"
// verdict beat a model-written `intentKind: "explore"`. Ambiguous tools whose
// subcommands may be read-only (npm, docker, kubectl, gh, brew, terraform) are
// deliberately absent so intent can still describe them.
const MUTATING_SHELL_COMMANDS = new Set([
	"apt",
	"apt-get",
	"chgrp",
	"chmod",
	"chown",
	"cp",
	"dd",
	"dnf",
	"install",
	"kill",
	"killall",
	"launchctl",
	"ln",
	"make",
	"mkdir",
	"mv",
	"pacman",
	"pkill",
	"rm",
	"rmdir",
	"rsync",
	"shred",
	"systemctl",
	"tee",
	"touch",
	"truncate",
	"unlink",
	"yum",
]);

const MUTATING_COMMAND_PATTERN = new RegExp(
	`(?:^|[\\s;&|(])(?:${[...MUTATING_SHELL_COMMANDS].join("|")})(?=$|[\\s;&|)])`,
);
// A redirect whose target is neither /dev/null nor a file-descriptor duplication.
const FILE_REDIRECT_PATTERN = />>?\s*(?!\s*(?:&[0-9]|\/dev\/null(?:$|[\s;&|])))/;

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"annotate",
	"cherry",
	"range-diff",
	"verify-commit",
	"verify-tag",
	"blame",
	"cat-file",
	"check-attr",
	"check-ignore",
	"count-objects",
	"describe",
	"diff",
	"diff-index",
	"diff-tree",
	"for-each-ref",
	"grep",
	"help",
	"log",
	"ls-files",
	"ls-remote",
	"ls-tree",
	"merge-base",
	"name-rev",
	"rev-list",
	"rev-parse",
	"shortlog",
	"show",
	"show-ref",
	"status",
	"var",
	"version",
	"whatchanged",
]);

// Git subcommands that read only for a specific option/subcommand shape; every
// other shape (create, delete, rename, set) is treated as mutating.
const READ_ONLY_GIT_SUBCOMMAND_MODES: Record<
	string,
	{ options: ReadonlySet<string>; modes: ReadonlySet<string>; valueOptions?: ReadonlySet<string> }
> = {
	branch: {
		options: new Set([
			"-a",
			"--all",
			"-r",
			"--remotes",
			"-v",
			"-vv",
			"--verbose",
			"-l",
			"--list",
			"--show-current",
			"--merged",
			"--no-merged",
			"--contains",
			"--no-contains",
			"--points-at",
			"--format",
			"--sort",
			"--color",
			"--no-color",
			"--column",
			"-i",
			"--ignore-case",
		]),
		modes: new Set(),
		valueOptions: new Set([
			"--merged",
			"--no-merged",
			"--contains",
			"--no-contains",
			"--points-at",
			"--format",
			"--sort",
			"-l",
			"--list",
		]),
	},
	remote: { options: new Set(["-v", "--verbose"]), modes: new Set(["show", "get-url"]) },
	tag: {
		options: new Set(["-l", "--list", "-n", "--contains", "--no-contains", "--points-at", "--merged", "--sort", "--format"]),
		modes: new Set(),
		valueOptions: new Set([
			"-l",
			"--list",
			"--contains",
			"--no-contains",
			"--points-at",
			"--merged",
			"--sort",
			"--format",
		]),
	},
	stash: { options: new Set([]), modes: new Set(["list", "show"]) },
	worktree: { options: new Set([]), modes: new Set(["list"]) },
	config: {
		options: new Set(["--get", "--get-all", "--get-regexp", "--list", "-l", "--global", "--local", "--show-origin"]),
		modes: new Set(["get", "list"]),
		valueOptions: new Set(["--get", "--get-all", "--get-regexp"]),
	},
	submodule: { options: new Set([]), modes: new Set(["status", "summary"]) },
	notes: { options: new Set([]), modes: new Set(["list", "show"]) },
};

// curl options that make the request write somewhere (disk, remote mutation) or
// leave the read-only realm.
const MUTATING_CURL_OPTIONS = new Set([
	"-o",
	"--output",
	"-O",
	"--remote-name",
	"--create-dirs",
	"-T",
	"--upload-file",
	"-d",
	"--data",
	"--data-raw",
	"--data-binary",
	"--data-urlencode",
	"--json",
	"-F",
	"--form",
	"--form-string",
	"-c",
	"--cookie-jar",
	"-D",
	"--dump-header",
	"--trace",
	"--trace-ascii",
	"-K",
	"--config",
]);

const READ_ONLY_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface ExplorationToolDescriptor {
	name: string;
	args?: unknown;
	label?: string;
	description?: string;
	isCustom?: boolean;
}

export type ToolPresentationKind = "exploration" | "mutation" | "command" | "remote" | "original";

export interface BashDisplayIntent {
	text: string;
	group?: string;
	groupText?: string;
}

export interface ExplorationGroupItem {
	id: string;
	exploration: boolean;
	breakBefore?: boolean;
}

export interface ExplorationGroup {
	items: ExplorationGroupItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function words(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function hasVerb(value: string, verbs: ReadonlySet<string>): boolean {
	return words(value).some((word) => verbs.has(word));
}

function commandSubstitutionAt(command: string, start: number): { content: string; end: number } | undefined {
	let depth = 1;
	let quote: "single" | "double" | undefined;
	let escaped = false;
	for (let index = start + 2; index < command.length; index += 1) {
		const character = command[index];
		if (!character) continue;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote === "single") {
			if (character === "'") quote = undefined;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (quote === "double") {
			if (character === '"') quote = undefined;
			else if (character === "`") return undefined;
			else if (character === "$" && command[index + 1] === "(") {
				depth += 1;
				index += 1;
			}
			continue;
		}
		if (character === "'") quote = "single";
		else if (character === '"') quote = "double";
		else if (character === "`") return undefined;
		else if (character === "(") depth += 1;
		else if (character === ")") {
			depth -= 1;
			if (depth === 0) return { content: command.slice(start + 2, index), end: index };
		}
	}
	return undefined;
}

function parseShellPipeline(command: string): string[][] | undefined {
	const stages: string[][] = [];
	let tokens: string[] = [];
	let token = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;
	let trailingCommandSeparator = false;
	const pushToken = () => {
		if (token.length === 0) return;
		tokens.push(token);
		token = "";
	};
	const pushStage = () => {
		pushToken();
		if (tokens.length === 0) return false;
		stages.push(tokens);
		tokens = [];
		return true;
	};

	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (!character) continue;
		if (escaped) {
			token += character;
			escaped = false;
			trailingCommandSeparator = false;
			continue;
		}
		if (quote === "single") {
			if (character === "'") quote = undefined;
			else token += character;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (quote === "double") {
			if (character === '"') quote = undefined;
			else {
				if (character === "`") return undefined;
				if (character === "$" && command[index + 1] === "(") {
					const substitution = commandSubstitutionAt(command, index);
					if (!substitution || !isReadOnlyShellCommand(substitution.content)) return undefined;
					token += "__command_substitution__";
					index = substitution.end;
					continue;
				}
				token += character;
			}
			continue;
		}
		if (character === "'") {
			quote = "single";
			trailingCommandSeparator = false;
			continue;
		}
		if (character === '"') {
			quote = "double";
			trailingCommandSeparator = false;
			continue;
		}
		if (character === "`") return undefined;
		if (character === "$" && command[index + 1] === "(") {
			const substitution = commandSubstitutionAt(command, index);
			if (!substitution || !isReadOnlyShellCommand(substitution.content)) return undefined;
			token += "__command_substitution__";
			index = substitution.end;
			continue;
		}
		if (character === "\n" || character === "\r") {
			if (!pushStage() && tokens.length > 0) return undefined;
			trailingCommandSeparator = true;
			continue;
		}
		if (character === "<") return undefined;
		if (character === ">") {
			if (command[index + 1] === ">") return undefined;
			const end = redirectTargetEnd(command, index + 1);
			if (end === undefined) return undefined;
			if (/^[0-9]+$/.test(token)) token = "";
			else pushToken();
			index = end - 1;
			trailingCommandSeparator = false;
			continue;
		}
		if (character === "&") {
			if (command[index + 1] === ">") {
				const offset = command[index + 2] === ">" ? undefined : index + 2;
				const end = offset === undefined ? undefined : redirectTargetEnd(command, offset);
				if (end === undefined) return undefined;
				pushToken();
				index = end - 1;
				trailingCommandSeparator = false;
				continue;
			}
			if (command[index + 1] !== "&" || !pushStage()) return undefined;
			index += 1;
			trailingCommandSeparator = false;
			continue;
		}
		if (character === ";") {
			if (!pushStage()) return undefined;
			trailingCommandSeparator = true;
			continue;
		}
		if (character === "|") {
			if (!pushStage()) return undefined;
			if (command[index + 1] === "|") index += 1;
			trailingCommandSeparator = false;
			continue;
		}
		if (/\s/.test(character)) pushToken();
		else {
			token += character;
			trailingCommandSeparator = false;
		}
	}
	if (quote || escaped) return undefined;
	if (!pushStage() && !trailingCommandSeparator) return undefined;
	return stages;
}

// Accepts `/dev/null` and file-descriptor duplications (`&1`, `&2`) as the only
// permitted redirect targets. Returns the index just past the target.
function redirectTargetEnd(command: string, start: number): number | undefined {
	let cursor = start;
	while (/\s/.test(command[cursor] ?? "")) cursor += 1;
	const duplication = /^&[0-9]+/.exec(command.slice(cursor));
	const end = duplication ? cursor + duplication[0].length : cursor + "/dev/null".length;
	if (!duplication && command.slice(cursor, end) !== "/dev/null") return undefined;
	const following = command[end];
	if (following !== undefined && !/[\s;&|<>\n\r]/.test(following)) return undefined;
	return end;
}

function shellCommandName(token: string): string {
	return token.slice(token.lastIndexOf("/") + 1);
}

function hasOption(tokens: readonly string[], option: string): boolean {
	return tokens.some((token) => token === option || token.startsWith(`${option}=`));
}

function isReadOnlyFind(tokens: readonly string[]): boolean {
	return !tokens.some(
		(token) =>
			token === "-delete" ||
			token === "-exec" ||
			token === "-execdir" ||
			token === "-ok" ||
			token === "-okdir" ||
			token.startsWith("-fls") ||
			token.startsWith("-fprint"),
	);
}

function isReadOnlySed(tokens: readonly string[]): boolean {
	let script: string | undefined;
	for (const token of tokens) {
		if (token === "-n" || token === "--quiet" || token === "--silent" || token === "-E" || token === "-r") {
			continue;
		}
		if (token === "--regexp-extended") continue;
		if (token.startsWith("-")) return false;
		script = token;
		break;
	}
	if (!script || script.includes(";")) return false;
	return /(?:^|\/)\s*(?:[^/\\]|\\.)*\/(?:[pdq=])$/.test(script) || /^[0-9,$+\-\s]*(?:[pdq=])$/.test(script);
}

const XARGS_OPTIONS_WITH_VALUE = new Set([
	"-a",
	"--arg-file",
	"-d",
	"--delimiter",
	"-E",
	"--eof",
	"-L",
	"--max-lines",
	"-n",
	"--max-args",
	"-P",
	"--max-procs",
	"-s",
	"--max-chars",
]);

const XARGS_FLAG_OPTIONS = new Set([
	"-0",
	"--null",
	"-o",
	"--open-tty",
	"-p",
	"--interactive",
	"-r",
	"--no-run-if-empty",
	"-t",
	"--verbose",
	"-x",
	"--exit",
]);

function isReadOnlyXargs(tokens: readonly string[]): boolean {
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index];
		if (!token) return false;
		if (token === "--") {
			index += 1;
			break;
		}
		if (!token.startsWith("-")) break;
		if (XARGS_FLAG_OPTIONS.has(token)) {
			index += 1;
			continue;
		}
		if (XARGS_OPTIONS_WITH_VALUE.has(token)) {
			if (tokens[index + 1] === undefined) return false;
			index += 2;
			continue;
		}
		if (
			["--arg-file=", "--delimiter=", "--eof=", "--max-lines=", "--max-args=", "--max-procs=", "--max-chars="].some(
				(prefix) => token.startsWith(prefix),
			)
		) {
			index += 1;
			continue;
		}
		return false;
	}
	return index < tokens.length && isReadOnlyShellStage(tokens.slice(index));
}

// A curl invocation counts as exploration only when it is a plain GET/HEAD that
// keeps its response on stdout.
function isReadOnlyCurl(tokens: readonly string[]): boolean {
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) return false;
		if (!token.startsWith("-")) continue;
		const [flag] = token.split("=", 1);
		if (flag !== undefined && MUTATING_CURL_OPTIONS.has(flag)) return false;
		if (flag === "-X" || flag === "--request") {
			const method = (token.includes("=") ? token.slice(token.indexOf("=") + 1) : tokens[index + 1]) ?? "";
			if (!READ_ONLY_HTTP_METHODS.has(method.toUpperCase())) return false;
			continue;
		}
		if (/^-[a-zA-Z]{2,}$/.test(token) && token.split("").some((character) => "oOTdFcDK".includes(character))) {
			return false;
		}
	}
	return true;
}

function isReadOnlyGitSubcommand(subcommand: string, args: readonly string[]): boolean {
	const mode = READ_ONLY_GIT_SUBCOMMAND_MODES[subcommand];
	if (!mode) return false;
	let index = 0;
	let modeMatched = false;
	let pendingValues = 0;
	if (args[0] !== undefined && !args[0].startsWith("-")) {
		if (!mode.modes.has(args[0])) return false;
		modeMatched = true;
		index = 1;
	}
	for (; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === undefined) return false;
		if (!argument.startsWith("-")) {
			if (modeMatched) continue;
			if (pendingValues === 0) return false;
			pendingValues -= 1;
			continue;
		}
		const flag = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
		if (!mode.options.has(flag)) return false;
		if (!argument.includes("=") && mode.valueOptions?.has(flag)) pendingValues += 1;
	}
	return true;
}

function isReadOnlyGit(tokens: readonly string[]): boolean {
	let index = 1;
	while (index < tokens.length) {
		const token = tokens[index];
		if (!token) return false;
		if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
			index += 2;
			continue;
		}
		if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=") || token === "--no-pager") {
			index += 1;
			continue;
		}
		break;
	}
	const subcommand = tokens[index];
	if (!subcommand) return false;
	const options = tokens.slice(index + 1);
	if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return isReadOnlyGitSubcommand(subcommand, options);
	return ![
		"--ext-diff",
		"--output",
		"--textconv",
		"--open-files-in-pager",
	].some((option) => hasOption(options, option));
}

// `cd` only moves the shell; anything beyond a single destination (or `-`) is
// unusual enough to fall back to the mutating classification.
function isReadOnlyCd(tokens: readonly string[]): boolean {
	if (tokens.length > 1) return false;
	const target = tokens[0];
	return target === undefined || target === "-" || !target.startsWith("-");
}

// `env` is read-only while it only sets variables; if it launches a command,
// that command decides.
function isReadOnlyEnv(tokens: readonly string[]): boolean {
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === undefined) return false;
		if (token === "-" || token === "-i" || token === "--ignore-environment" || token === "-0" || token === "--null") {
			index += 1;
			continue;
		}
		if (token === "-u" || token === "--unset") {
			index += 2;
			continue;
		}
		if (token.startsWith("-")) return false;
		if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) break;
		index += 1;
	}
	return index >= tokens.length || isReadOnlyShellStage(tokens.slice(index));
}

// `awk` can write files (`print > "f"`), pipe into shells, and call `system()`,
// so only programs free of those constructs count as read-only.
function isReadOnlyAwk(tokens: readonly string[]): boolean {
	return !tokens.some((token) => /system\s*\(|printf?\s*[^;]*[>|]|close\s*\(|[>|]\s*"/.test(token));
}

function isReadOnlyFd(tokens: readonly string[]): boolean {
	return !tokens.some(
		(token) => token === "-x" || token === "-X" || token.startsWith("--exec") || token.startsWith("--batch-size"),
	);
}

function isReadOnlyShellStage(tokens: readonly string[]): boolean {
	const command = tokens[0];
	if (!command) return false;
	if (SHELL_BLOCK_WORDS.has(command)) return tokens.length === 1 || isReadOnlyShellStage(tokens.slice(1));
	if (SHELL_CONTROL_WORDS.has(command)) return tokens.length === 1 || isReadOnlyShellStage(tokens.slice(1));
	if (SHELL_WORD_LIST_KEYWORDS.has(command)) return true;
	const name = shellCommandName(command);
	if (name === "cd") return isReadOnlyCd(tokens.slice(1));
	if (name === "env") return isReadOnlyEnv(tokens.slice(1));
	if (name === "awk" || name === "gawk" || name === "nawk") return isReadOnlyAwk(tokens.slice(1));
	if (name === "fd" || name === "fdfind") return isReadOnlyFd(tokens.slice(1));
	if (name === "find") return isReadOnlyFind(tokens.slice(1));
	if (name === "sed") return isReadOnlySed(tokens.slice(1));
	if (name === "xargs") return isReadOnlyXargs(tokens.slice(1));
	if (name === "git") return isReadOnlyGit(tokens);
	if (name === "curl") return isReadOnlyCurl(tokens.slice(1));
	if (!READ_ONLY_SHELL_COMMANDS.has(name)) return false;
	if (name === "rg" && tokens.slice(1).some((token) => token === "--pre" || token.startsWith("--pre="))) return false;
	if (
		(name === "sort" || name === "tree") &&
		tokens.slice(1).some((token) => token === "-o" || token.startsWith("-o") || token.startsWith("--output"))
	) {
		return false;
	}
	return true;
}

export function isReadOnlyShellCommand(command: string): boolean {
	const stages = parseShellPipeline(command.trim());
	return stages !== undefined && stages.every(isReadOnlyShellStage);
}

/**
 * `read-only` and `mutating` are deterministic verdicts that the model cannot
 * override. `unknown` covers commands this parser cannot decide — interpreters
 * (`python3 -c`), unrecognized binaries, unsupported syntax — and is the only
 * verdict where a model-written `intentKind` is consulted.
 */
export type ShellCommandVerdict = "read-only" | "mutating" | "unknown";

function isMutatingShellStage(tokens: readonly string[]): boolean {
	const command = tokens[0];
	if (!command) return false;
	// Look past control words and wrappers to the command that actually runs.
	if (SHELL_BLOCK_WORDS.has(command) || SHELL_CONTROL_WORDS.has(command)) {
		return tokens.length > 1 && isMutatingShellStage(tokens.slice(1));
	}
	if (SHELL_WORD_LIST_KEYWORDS.has(command)) return false;
	const name = shellCommandName(command);
	if (MUTATING_SHELL_COMMANDS.has(name)) return true;
	if (name === "env") {
		const index = tokens.slice(1).findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && !token.startsWith("-"));
		return index >= 0 && isMutatingShellStage(tokens.slice(index + 1));
	}
	if (name === "xargs") {
		const index = tokens.slice(1).findIndex((token) => !token.startsWith("-"));
		return index >= 0 && isMutatingShellStage(tokens.slice(index + 1));
	}
	// Any git subcommand not proven read-only is treated as mutating.
	if (name === "git") return true;
	if (name === "sed") return tokens.slice(1).some((token) => token.startsWith("-i"));
	return false;
}

function shellStageVerdict(tokens: readonly string[]): ShellCommandVerdict {
	if (isReadOnlyShellStage(tokens)) return "read-only";
	return isMutatingShellStage(tokens) ? "mutating" : "unknown";
}

export function classifyShellCommand(command: string): ShellCommandVerdict {
	const trimmed = command.trim();
	if (trimmed.length === 0) return "unknown";
	const stages = parseShellPipeline(trimmed);
	if (stages === undefined) {
		// Unparseable input: fall back to a textual scan so obvious destruction
		// inside unsupported syntax is still reported as mutating.
		if (FILE_REDIRECT_PATTERN.test(trimmed) || MUTATING_COMMAND_PATTERN.test(trimmed)) return "mutating";
		return "unknown";
	}
	const verdicts = stages.map(shellStageVerdict);
	if (verdicts.includes("mutating")) return "mutating";
	return verdicts.every((verdict) => verdict === "read-only") ? "read-only" : "unknown";
}

function operationValues(args: unknown): string[] {
	if (!isRecord(args)) return [];
	const values: string[] = [];
	for (const key of MCP_OPERATION_KEYS) {
		const value = args[key];
		if (typeof value === "string") values.push(value);
		if (value === true && (key === "describe" || key === "search")) values.push(key);
	}
	return values;
}

function mcpOperation(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	if (typeof args.action === "string") return args.action;
	if (typeof args.tool === "string") return args.tool;
	if (typeof args.search === "string" || args.search === true) return "search";
	if (typeof args.describe === "string" || args.describe === true) return "describe";
	if (typeof args.server === "string") return "list";
	return undefined;
}

function metadataText(tool: ExplorationToolDescriptor): string {
	return [tool.name, tool.label, tool.description]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
}

/** Read the model-written intent kind, ignoring unknown values. */
export function toolIntentKind(args: unknown): IntentKind | undefined {
	if (!isRecord(args)) return undefined;
	const value = args[INTENT_KIND_FIELD];
	return typeof value === "string" && (INTENT_KINDS as readonly string[]).includes(value)
		? (value as IntentKind)
		: undefined;
}

export function isExplorationTool(tool: ExplorationToolDescriptor): boolean {
	const name = tool.name.toLowerCase();
	// The model may always downgrade a call out of the exploration group; it may
	// never upgrade one that this module proved to be a mutation.
	if (toolIntentKind(tool.args) === "modify") return false;
	if (EXPLORATION_BUILT_INS.has(name) || PI_WEB_ACCESS_TOOLS.has(name)) return true;
	if (SHELL_TOOL_NAMES.has(name)) {
		const command = isRecord(tool.args) && typeof tool.args.command === "string" ? tool.args.command : undefined;
		if (command === undefined) return false;
		const verdict = classifyShellCommand(command);
		if (verdict !== "unknown") return verdict === "read-only";
		return toolIntentKind(tool.args) === "explore";
	}
	if (name === "agent") return stringArg(tool.args, ["subagent_type"])?.toLowerCase() === "explore";
	if (name === "get_subagent_result") return true;

	if (name === "mcp") {
		const operations = operationValues(tool.args);
		if (operations.some((value) => hasVerb(value, BLOCKED_VERBS))) return false;
		const operation = mcpOperation(tool.args);
		return operation !== undefined && hasVerb(operation, RETRIEVAL_VERBS);
	}

	const metadata = metadataText(tool);
	if (hasVerb(metadata, BLOCKED_VERBS)) return false;
	return hasVerb(metadata, RETRIEVAL_VERBS);
}

export function classifyToolPresentation(tool: ExplorationToolDescriptor): ToolPresentationKind {
	if (isExplorationTool(tool)) return "exploration";
	const name = tool.name.toLowerCase();
	if (name === "edit" || name === "write") return "mutation";
	if (SHELL_TOOL_NAMES.has(name)) return "command";
	if (name === "mcp" || tool.isCustom === true) return "remote";
	return "original";
}

function cleanDisplayText(value: string): string {
	return value
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001F\u007F]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function stringArg(args: unknown, keys: readonly string[]): string | undefined {
	if (!isRecord(args)) return undefined;
	for (const key of keys) {
		const value = args[key];
		if (typeof value !== "string") continue;
		const cleaned = cleanDisplayText(value);
		if (cleaned) return cleaned;
	}
	return undefined;
}

function stringArrayArg(args: unknown, key: string): string[] {
	if (!isRecord(args) || !Array.isArray(args[key])) return [];
	return args[key]
		.filter((value): value is string => typeof value === "string")
		.map(cleanDisplayText)
		.filter(Boolean);
}

function capitalize(value: string): string {
	return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function humanize(value: string): string {
	return words(value).join(" ");
}

function locationSuffix(args: unknown): string {
	const path = stringArg(args, ["path", "file_path", "directory", "cwd"]);
	return path ? ` in ${path}` : "";
}

function formatRead(args: unknown): string {
	const path = stringArg(args, ["path", "file_path"]) ?? "…";
	if (!isRecord(args) || typeof args.offset !== "number") return `Read ${path}`;
	const end = typeof args.limit === "number" ? args.offset + args.limit - 1 : undefined;
	return `Read ${path}:${args.offset}${end === undefined ? "" : `-${end}`}`;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
	if (isRecord(value)) return value;
	if (typeof value !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function nestedTarget(args: unknown): string | undefined {
	let target = stringArg(args, TARGET_KEYS);
	if (target || !isRecord(args)) return target;
	for (const key of ["arguments", "args", "params", "input"] as const) {
		target = stringArg(parseJsonObject(args[key]), TARGET_KEYS);
		if (target) return target;
	}
	return undefined;
}

function formatMcp(args: unknown): string {
	const operation = mcpOperation(args);
	const server = stringArg(args, ["server"]);
	const target = nestedTarget(args);
	const parts = ["MCP", operation ? humanize(operation) : "retrieve", server, target];
	return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}

function formatWebSearch(args: unknown): string {
	const query = stringArg(args, ["query"]);
	if (query) return `Web search ${query}`;
	const queries = stringArrayArg(args, "queries");
	if (queries.length === 0) return "Web search";
	const remaining = queries.length - 2;
	return `Web search ${queries.slice(0, 2).join("; ")}${remaining > 0 ? ` (+${remaining})` : ""}`;
}

function formatFetchContent(args: unknown): string {
	const url = stringArg(args, ["url"]);
	if (url) return `Fetch ${url}`;
	const urls = stringArrayArg(args, "urls");
	if (urls.length === 0) return "Fetch content";
	return `Fetch ${urls[0]}${urls.length > 1 ? ` (+${urls.length - 1})` : ""}`;
}

function formatStoredSearchContent(args: unknown): string {
	const target = stringArg(args, ["query", "url", "responseId"]);
	return target ? `Retrieve search content ${target}` : "Retrieve search content";
}

function lineCount(value: string): number {
	if (value.length === 0) return 0;
	const count = value.split(/\r\n|\r|\n/).length;
	return /(?:\r\n|\r|\n)$/.test(value) ? count - 1 : count;
}

function diffStatistics(diff: string): { added: number; removed: number } | undefined {
	let added = 0;
	let removed = 0;
	for (const line of diff.split(/\r\n|\r|\n/)) {
		if (line.startsWith("+")) added += 1;
		else if (line.startsWith("-")) removed += 1;
	}
	return added > 0 || removed > 0 ? { added, removed } : undefined;
}

function editArgumentStatistics(args: unknown): { added: number; removed: number } | undefined {
	if (!isRecord(args)) return undefined;
	const edits = Array.isArray(args.edits)
		? args.edits
		: typeof args.oldText === "string" && typeof args.newText === "string"
			? [{ oldText: args.oldText, newText: args.newText }]
			: [];
	let added = 0;
	let removed = 0;
	let valid = false;
	for (const edit of edits) {
		if (!isRecord(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string") continue;
		valid = true;
		removed += lineCount(edit.oldText);
		added += lineCount(edit.newText);
	}
	return valid ? { added, removed } : undefined;
}

export function formatMutationTarget(tool: ExplorationToolDescriptor): string {
	return stringArg(tool.args, ["path", "file_path"]) ?? "…";
}

export function formatMutationStatistics(tool: ExplorationToolDescriptor, details?: unknown): string | undefined {
	const name = tool.name.toLowerCase();
	if (name === "write") {
		const content = isRecord(tool.args) && typeof tool.args.content === "string" ? tool.args.content : undefined;
		if (content === undefined) return undefined;
		const count = lineCount(content);
		return `${count} ${count === 1 ? "line" : "lines"}`;
	}
	if (name !== "edit") return undefined;
	const resultDiff = isRecord(details) && typeof details.diff === "string" ? diffStatistics(details.diff) : undefined;
	const statistics = resultDiff ?? editArgumentStatistics(tool.args);
	return statistics ? `+${statistics.added} -${statistics.removed} lines` : undefined;
}

export function bashDisplayIntent(tool: ExplorationToolDescriptor): BashDisplayIntent | undefined {
	if (!SHELL_TOOL_NAMES.has(tool.name.toLowerCase())) return undefined;
	const text = stringArg(tool.args, [INTENT_TEXT_FIELD]);
	if (!text) return undefined;
	const group = stringArg(tool.args, [INTENT_GROUP_FIELD]);
	const groupText = stringArg(tool.args, [INTENT_GROUP_TEXT_FIELD]);
	return { text, ...(group ? { group } : {}), ...(groupText ? { groupText } : {}) };
}

export function formatCommandSummary(tool: ExplorationToolDescriptor, maxCommandCharacters?: number): string {
	const command = stringArg(tool.args, ["command"]) ?? "…";
	if (maxCommandCharacters === undefined) return `$ ${command}`;
	const characters = Array.from(command);
	const truncated = characters.length > maxCommandCharacters
		? `${characters.slice(0, maxCommandCharacters).join("")}…`
		: command;
	return `$ ${truncated}`;
}

export function formatIntentCommandSummary(
	tool: ExplorationToolDescriptor,
	maxCommandCharacters?: number,
): string | undefined {
	const intent = bashDisplayIntent(tool);
	return intent ? `${intent.text} · ${formatCommandSummary(tool, maxCommandCharacters)}` : undefined;
}

export function formatRemoteActionSummary(tool: ExplorationToolDescriptor): string {
	const name = tool.name.toLowerCase();
	if (name === "mcp") return formatMcp(tool.args);
	const label = (tool.label ? cleanDisplayText(tool.label) : "") || humanize(tool.name) || "tool";
	const target = name === "agent" ? stringArg(tool.args, ["description"]) : nestedTarget(tool.args);
	const summary = capitalize(label);
	return target ? `${summary} ${target}` : summary;
}

export function formatExplorationSummary(tool: ExplorationToolDescriptor): string {
	const name = tool.name.toLowerCase();
	if (name === "read") return formatRead(tool.args);
	if (name === "grep") {
		return `Search ${stringArg(tool.args, ["pattern", "query"]) ?? "…"}${locationSuffix(tool.args)}`;
	}
	if (name === "find") {
		return `Find ${stringArg(tool.args, ["pattern", "query", "name"]) ?? "…"}${locationSuffix(tool.args)}`;
	}
	if (name === "ls") return `List ${stringArg(tool.args, ["path", "directory"]) ?? "."}`;
	if (SHELL_TOOL_NAMES.has(name)) {
		return formatIntentCommandSummary(tool, INTENT_COMMAND_CHARACTER_LIMIT) ?? formatCommandSummary(tool);
	}
	if (name === "mcp") return formatMcp(tool.args);
	if (name === "web_search") return formatWebSearch(tool.args);
	if (name === "fetch_content") return formatFetchContent(tool.args);
	if (name === "get_search_content") return formatStoredSearchContent(tool.args);
	if (name === "agent") return `Explore ${stringArg(tool.args, ["description"]) ?? "with subagent"}`;
	if (name === "get_subagent_result") {
		const agentId = stringArg(tool.args, ["agent_id"]);
		return agentId ? `Get subagent result ${agentId}` : "Get subagent result";
	}

	const label = (tool.label ? cleanDisplayText(tool.label) : "") || humanize(tool.name) || "Retrieve";
	const target = stringArg(tool.args, TARGET_KEYS);
	return target ? `${capitalize(label)} ${target}` : capitalize(label);
}

export function groupExplorationItems(items: readonly ExplorationGroupItem[]): ExplorationGroup[] {
	const groups: ExplorationGroup[] = [];
	let current: ExplorationGroup | undefined;
	for (const item of items) {
		if (!item.exploration) {
			current = undefined;
			continue;
		}
		if (!current || item.breakBefore === true) {
			current = { items: [] };
			groups.push(current);
		}
		current.items.push(item);
	}
	return groups;
}
