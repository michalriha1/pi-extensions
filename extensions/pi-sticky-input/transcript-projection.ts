type SessionMethod = (this: object, ...args: never[]) => unknown;

interface ResolvedMethod {
	descriptor: PropertyDescriptor & { value: SessionMethod };
	method: SessionMethod;
}

function resolveDataMethod(instance: object, key: PropertyKey): ResolvedMethod | undefined {
	let current: object | null = instance;
	while (current) {
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor) {
			if (!("value" in descriptor) || typeof descriptor.value !== "function") return undefined;
			if (Reflect.get(instance, key) !== descriptor.value) return undefined;
			return {
				descriptor: descriptor as PropertyDescriptor & { value: SessionMethod },
				method: descriptor.value as SessionMethod,
			};
		}
		current = Object.getPrototypeOf(current) as object | null;
	}
	return undefined;
}

/**
 * Project the complete active branch through Pi's instance method used by the
 * native transcript renderer. Installation is rejected unless the manager's
 * LLM context builder is demonstrably independent from that instance method.
 */
export function installFullBranchTranscriptProjection(sessionManager: object): (() => void) | undefined {
	try {
		const buildContextEntries = resolveDataMethod(sessionManager, "buildContextEntries");
		const getBranch = resolveDataMethod(sessionManager, "getBranch");
		const buildSessionContext = resolveDataMethod(sessionManager, "buildSessionContext");
		if (!buildContextEntries || !getBranch || !buildSessionContext) return undefined;

		const previous = Object.getOwnPropertyDescriptor(sessionManager, "buildContextEntries");
		if (previous && (!previous.configurable || !("value" in previous))) return undefined;
		if (!previous && !Object.isExtensible(sessionManager)) return undefined;

		let validatingContextIsolation = false;
		let contextBuilderUsedProjection = false;
		const wrapper: SessionMethod = function (): unknown {
			if (validatingContextIsolation) {
				contextBuilderUsedProjection = true;
				return buildContextEntries.method.call(sessionManager);
			}
			return getBranch.method.call(sessionManager);
		};
		const restore = (): void => {
			try {
				const current = Object.getOwnPropertyDescriptor(sessionManager, "buildContextEntries");
				if (!current || !("value" in current) || current.value !== wrapper) return;
				if (previous) {
					Object.defineProperty(sessionManager, "buildContextEntries", previous);
				} else {
					Reflect.deleteProperty(sessionManager, "buildContextEntries");
				}
			} catch {
				// Another owner changed the descriptor; never clobber or break shutdown.
			}
		};

		Object.defineProperty(sessionManager, "buildContextEntries", {
			configurable: true,
			enumerable: previous?.enumerable ?? buildContextEntries.descriptor.enumerable ?? false,
			writable: previous && "writable" in previous
				? previous.writable
				: buildContextEntries.descriptor.writable ?? true,
			value: wrapper,
		});

		try {
			validatingContextIsolation = true;
			buildSessionContext.method.call(sessionManager);
		} catch {
			restore();
			return undefined;
		} finally {
			validatingContextIsolation = false;
		}
		if (contextBuilderUsedProjection) {
			restore();
			return undefined;
		}

		return restore;
	} catch {
		return undefined;
	}
}
