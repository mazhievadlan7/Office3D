import { describe, expect, it } from "vitest";

const { handleMethod } = await import("../../server/hermes-gateway-adapter.js");

/**
 * These are the methods Studio calls that the Hermes adapter does not
 * implement. It used to answer all of them with `ok: true` and an empty
 * payload, so Studio treated them as completed: Kanban edits looked saved but
 * were discarded, usage analytics rendered zeros as real figures, and
 * skills.install reported an install that never happened.
 */
const UNSUPPORTED_METHODS = [
  "tasks.create",
  "tasks.update",
  "tasks.delete",
  "skills.install",
  "skills.update",
  "sessions.usage",
  "usage.cost",
];

describe("hermes-gateway-adapter", () => {
  it("rejects_methods_it_does_not_implement_instead_of_faking_success", async () => {
    for (const [index, method] of UNSUPPORTED_METHODS.entries()) {
      const id = String(index);
      await expect(handleMethod(method, {}, id, () => {})).resolves.toMatchObject({
        type: "res",
        id,
        ok: false,
        error: { code: "unsupported_method" },
      });
    }
  });

  it("names_the_rejected_method_so_the_ui_can_report_it", async () => {
    // The handler's return type is a union of the ok and error shapes, so the
    // error branch is asserted through toMatchObject rather than by reaching
    // into a property that only exists on one member.
    await expect(handleMethod("tasks.create", {}, "1", () => {})).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("tasks.create") },
    });
  });

  it("still_answers_a_method_it_does_implement", async () => {
    // Guards against the default case swallowing supported methods: tasks.list
    // is implemented, and only the mutations above are not.
    const response = await handleMethod("tasks.list", {}, "1", () => {});
    expect(response).toMatchObject({ type: "res", id: "1", ok: true });
  });
});
