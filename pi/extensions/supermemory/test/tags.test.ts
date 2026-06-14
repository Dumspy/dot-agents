import { describe, expect, it } from "vitest";
import { getTags } from "../tags.ts";

describe("getTags", () => {
	it("returns deterministic user and project tags", () => {
		const tags1 = getTags("/home/user/project");
		const tags2 = getTags("/home/user/project");

		expect(tags1.user).toMatch(/^pi_user_[a-f0-9]{16}$/);
		expect(tags1.project).toMatch(/^pi_project_[a-f0-9]{16}$/);
		expect(tags1).toEqual(tags2);
	});

	it("produces different project tags for different directories", () => {
		const tagsA = getTags("/home/user/project-a");
		const tagsB = getTags("/home/user/project-b");

		expect(tagsA.project).not.toBe(tagsB.project);
	});

	it("keeps the same user tag across projects", () => {
		const tagsA = getTags("/home/user/project-a");
		const tagsB = getTags("/home/user/project-b");

		expect(tagsA.user).toBe(tagsB.user);
	});
});
