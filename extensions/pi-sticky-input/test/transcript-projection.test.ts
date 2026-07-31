import assert from "node:assert/strict";
import test from "node:test";

import { installFullBranchTranscriptProjection } from "../transcript-projection.ts";

interface Entry {
	id: string;
	type: "message" | "compaction";
}

function compacted(entries: readonly Entry[]): Entry[] {
	const latestCompaction = entries.findLastIndex((entry) => entry.type === "compaction");
	return latestCompaction < 0 ? [...entries] : entries.slice(latestCompaction);
}

class SessionManagerFixture {
	branch: Entry[] = [
		{ id: "old-user", type: "message" },
		{ id: "old-assistant", type: "message" },
		{ id: "first-compaction", type: "compaction" },
		{ id: "kept-tail", type: "message" },
	];
	contextBuilds = 0;

	getBranch(): Entry[] {
		return [...this.branch];
	}

	buildContextEntries(): Entry[] {
		return compacted(this.branch);
	}

	buildSessionContext(): { messages: Entry[] } {
		this.contextBuilds += 1;
		return { messages: compacted(this.branch) };
	}
}

test("transcript projection follows the complete active branch across repeated compactions", () => {
	const manager = new SessionManagerFixture();
	const originalSessionContext = manager.buildSessionContext;
	const restore = installFullBranchTranscriptProjection(manager);
	assert.ok(restore);
	assert.deepEqual(manager.buildContextEntries(), manager.getBranch());

	manager.branch.push(
		{ id: "second-compaction", type: "compaction" },
		{ id: "latest-message", type: "message" },
	);
	assert.deepEqual(manager.buildContextEntries(), manager.getBranch());
	assert.deepEqual(manager.buildSessionContext().messages, [
		{ id: "second-compaction", type: "compaction" },
		{ id: "latest-message", type: "message" },
	]);
	assert.equal(manager.buildSessionContext, originalSessionContext);
	assert.equal(manager.contextBuilds, 2); // one isolation check during install, one assertion above
});

test("projection preserves active-branch semantics instead of exposing sibling entries", () => {
	const manager = new SessionManagerFixture();
	const restore = installFullBranchTranscriptProjection(manager);
	assert.ok(restore);

	manager.branch = [
		{ id: "root", type: "message" },
		{ id: "selected-sibling", type: "message" },
	];
	assert.deepEqual(manager.buildContextEntries().map((entry) => entry.id), ["root", "selected-sibling"]);
});

test("descriptor restoration is exact, instance-only, and idempotent", () => {
	const manager = new SessionManagerFixture();
	const other = new SessionManagerFixture();
	const original = manager.buildContextEntries;
	Object.defineProperty(manager, "buildContextEntries", {
		configurable: true,
		enumerable: true,
		writable: false,
		value: original,
	});
	const before = Object.getOwnPropertyDescriptor(manager, "buildContextEntries");
	const restore = installFullBranchTranscriptProjection(manager);
	assert.ok(restore);
	assert.notEqual(manager.buildContextEntries, original);
	assert.equal(Object.hasOwn(other, "buildContextEntries"), false);

	restore();
	restore();
	assert.deepEqual(Object.getOwnPropertyDescriptor(manager, "buildContextEntries"), before);
	assert.equal(manager.buildContextEntries, original);
});

test("installation fails closed when buildSessionContext depends on the projected method", () => {
	class CoupledManager extends SessionManagerFixture {
		override buildSessionContext(): { messages: Entry[] } {
			return { messages: this.buildContextEntries() };
		}
	}
	const manager = new CoupledManager();
	const original = manager.buildContextEntries;

	assert.equal(installFullBranchTranscriptProjection(manager), undefined);
	assert.equal(Object.hasOwn(manager, "buildContextEntries"), false);
	assert.equal(manager.buildContextEntries, original);
	assert.deepEqual(manager.buildSessionContext().messages, compacted(manager.branch));
});

test("installation fails closed for incompatible descriptors", () => {
	const manager = new SessionManagerFixture();
	Object.defineProperty(manager, "buildContextEntries", {
		configurable: false,
		enumerable: false,
		writable: false,
		value: manager.buildContextEntries,
	});

	assert.equal(installFullBranchTranscriptProjection(manager), undefined);
	assert.deepEqual(manager.buildContextEntries(), compacted(manager.branch));
});
