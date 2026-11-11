// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { UIProviders } from "./providers";
import { ThemePreference } from "./theme-preference";
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.className = "";
});
it("lets a user change and restore a saved appearance across nested workspaces", async () => {
  const view = render(
    <UIProviders>
      <UIProviders>
        <ThemePreference />
      </UIProviders>
    </UIProviders>,
  );
  fireEvent.change(screen.getByLabelText("外观"), {
    target: { value: "dark" },
  });
  await waitFor(() =>
    expect(document.documentElement.classList.contains("dark")).toBe(true),
  );
  expect(localStorage.getItem("routeweaver-theme")).toBe("dark");
  view.unmount();
  render(
    <UIProviders>
      <ThemePreference />
    </UIProviders>,
  );
  await waitFor(() =>
    expect((screen.getByLabelText("外观") as HTMLSelectElement).value).toBe(
      "dark",
    ),
  );
  fireEvent.change(screen.getByLabelText("外观"), {
    target: { value: "light" },
  });
  await waitFor(() =>
    expect(document.documentElement.classList.contains("dark")).toBe(false),
  );
  expect(document.documentElement.style.colorScheme).toBe("light");
  fireEvent.change(screen.getByLabelText("外观"), {
    target: { value: "system" },
  });
  expect(localStorage.getItem("routeweaver-theme")).toBe("system");
});
