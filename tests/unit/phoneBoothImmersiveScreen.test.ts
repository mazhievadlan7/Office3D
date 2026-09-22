import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  PhoneBoothImmersiveScreen,
  stepForCallStatus,
  type PhoneBoothCallView,
} from "@/features/office/screens/PhoneBoothImmersiveScreen";

const view = (overrides: Partial<PhoneBoothCallView> = {}): PhoneBoothCallView => ({
  dialNumber: "+447700900123",
  agentName: "Nova",
  status: "in-progress",
  turns: [],
  ...overrides,
});

afterEach(cleanup);

describe("stepForCallStatus", () => {
  it("follows_the_call_rather_than_a_timer", () => {
    expect(stepForCallStatus("queued")).toBe("dialing");
    expect(stepForCallStatus("ringing")).toBe("ringing");
    expect(stepForCallStatus("in-progress")).toBe("speaking");
    // Still speaking on screen while the transcript finishes: the line has
    // dropped but the record is not final.
    expect(stepForCallStatus("processing")).toBe("speaking");
    for (const status of ["completed", "busy", "no-answer", "canceled", "failed"] as const) {
      expect(stepForCallStatus(status)).toBe("complete");
    }
  });
});

describe("PhoneBoothImmersiveScreen", () => {
  it("shows_the_number_that_was_dialled_and_who_is_calling", () => {
    render(
      createElement(PhoneBoothImmersiveScreen, { call: view(), typedDigits: "+4477" }),
    );
    expect(screen.getAllByText("+447700900123").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Nova").length).toBeGreaterThan(0);
  });

  it("shows_only_words_that_were_actually_said", () => {
    render(
      createElement(PhoneBoothImmersiveScreen, {
        call: view({
          turns: [
            { id: "t1", speaker: "agent", text: "Good morning, calling about the invoice." },
            { id: "t2", speaker: "callee", text: "Go ahead." },
          ],
        }),
        typedDigits: "",
      }),
    );
    expect(screen.getByText("Good morning, calling about the invoice.")).toBeTruthy();
    expect(screen.getByText("Go ahead.")).toBeTruthy();
  });

  it("waits_rather_than_inventing_an_opening_line", () => {
    // The old booth scripted both sides of the conversation. Before anyone
    // speaks there is nothing to show, and guessing would put words in the
    // agent's mouth.
    render(createElement(PhoneBoothImmersiveScreen, { call: view(), typedDigits: "" }));
    expect(screen.getByText("Ждём первых слов…")).toBeTruthy();
  });

  it("says_nothing_was_said_when_a_finished_call_had_no_words", () => {
    render(
      createElement(PhoneBoothImmersiveScreen, {
        call: view({ status: "no-answer" }),
        typedDigits: "",
      }),
    );
    expect(screen.getByText("На этом звонке ничего не прозвучало.")).toBeTruthy();
    expect(screen.getAllByText("Нет ответа").length).toBeGreaterThan(0);
  });

  it("reports_a_failed_call_as_failed", () => {
    render(
      createElement(PhoneBoothImmersiveScreen, {
        call: view({ status: "failed" }),
        typedDigits: "",
      }),
    );
    expect(screen.getAllByText("Звонок не удался").length).toBeGreaterThan(0);
  });
});
