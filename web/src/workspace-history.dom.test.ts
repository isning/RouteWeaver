// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { createWorkspaceHistory } from "./workspace-history";
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});
it("Back closes a detail and Forward restores that exact detail", async () => {
  history.replaceState(null, "", "#subscriptions?profile=one");
  let visible = location.hash;
  const navigation = createWorkspaceHistory({
    isDirty: () => false,
    confirm: () => {},
    accept: (hash) => {
      visible = hash;
    },
  });
  dispose = navigation.dispose;
  navigation.navigate("#subscriptions?profile=one&output=phone");
  expect(visible).toBe("#subscriptions?profile=one&output=phone");
  history.back();
  await waitFor(() => expect(visible).toBe("#subscriptions?profile=one"));
  history.forward();
  await waitFor(() =>
    expect(visible).toBe("#subscriptions?profile=one&output=phone"),
  );
});

function setup(hash = "#subscriptions?profile=one") {
  history.replaceState(null, "", hash);
  let dirty = false;
  let active = true;
  let visible = location.hash;
  let discards = 0;
  const decisions: { proceed(): void; cancel(): void; unowned?: boolean }[] =
    [];
  let traversals = 0;
  const countTraversal = () => {
    traversals++;
  };
  window.addEventListener("popstate", countTraversal, true);
  const navigation = createWorkspaceHistory({
    isDirty: () => dirty,
    isActive: () => active,
    confirm: (proceed, cancel, context) => {
      decisions.push({ proceed, cancel, unowned: context?.unowned });
    },
    accept: (hash, discarded) => {
      visible = hash;
      if (discarded) {
        discards++;
        dirty = false;
      }
    },
  });
  dispose = () => {
    navigation.dispose();
    window.removeEventListener("popstate", countTraversal, true);
  };
  return {
    navigation,
    decisions,
    traversals: () => traversals,
    dirty: () => {
      dirty = true;
    },
    active: (value: boolean) => {
      active = value;
    },
    visible: () => visible,
    discards: () => discards,
  };
}
const list = "#subscriptions?profile=one";
const detail = list + "&output=phone";
it("dirty Back cancellation preserves both entries; a later discard keeps Forward usable", async () => {
  const h = setup();
  const listProof = history.state;
  h.navigation.navigate(detail);
  const detailProof = history.state;
  h.dirty();
  history.back();
  await waitFor(() => expect(h.decisions).toHaveLength(1));
  expect(location.hash).toBe(detail);
  expect(history.state).toEqual(detailProof);
  expect(h.visible()).toBe(detail);
  h.decisions[0].cancel();
  history.back();
  await waitFor(() => expect(h.decisions).toHaveLength(2));
  h.decisions[1].proceed();
  h.decisions[1].proceed();
  await waitFor(() => expect(h.visible()).toBe(list));
  expect(history.state).toEqual(listProof);
  expect(h.discards()).toBe(1);
  history.forward();
  await waitFor(() => expect(h.visible()).toBe(detail));
  expect(history.state).toEqual(detailProof);
  expect(h.decisions).toHaveLength(2);
});
it("dirty Forward cancellation restores its source entry and permits one confirmed Forward", async () => {
  const h = setup();
  h.navigation.navigate(detail);
  history.back();
  await waitFor(() => expect(h.visible()).toBe(list));
  h.dirty();
  history.forward();
  await waitFor(() => expect(h.decisions).toHaveLength(1));
  expect(location.hash).toBe(list);
  h.decisions[0].cancel();
  history.forward();
  await waitFor(() => expect(h.decisions).toHaveLength(2));
  h.decisions[1].proceed();
  await waitFor(() => expect(h.visible()).toBe(detail));
  expect(h.discards()).toBe(1);
});
it("dirty UI navigation does not change history before the user's decision", () => {
  const h = setup();
  h.dirty();
  const length = history.length;
  h.navigation.navigate(detail);
  expect(location.hash).toBe(list);
  expect(history.length).toBe(length);
  h.decisions[0].cancel();
  h.navigation.navigate(detail);
  h.decisions[1].proceed();
  expect(h.visible()).toBe(detail);
  expect(h.discards()).toBe(1);
});
it("Close returns to an owned immediate list predecessor; Forward restores detail", async () => {
  const h = setup();
  h.navigation.navigate(detail);
  const length = history.length;
  h.navigation.closeDetail();
  await waitFor(() => expect(h.visible()).toBe(list));
  expect(history.length).toBe(length);
  history.forward();
  await waitFor(() => expect(h.visible()).toBe(detail));
});
it("direct-link Close replaces only output, preserving the exact profile and unrelated parameters", () => {
  const h = setup("#subscriptions?profileId=one&outputId=missing&tab=links");
  const length = history.length;
  h.navigation.closeDetail();
  expect(location.hash).toBe("#subscriptions?profileId=one&tab=links");
  expect(history.length).toBe(length);
});
it("inactive traversal restores without a hidden confirmation and resumes the same intent", async () => {
  const h = setup();
  h.navigation.navigate(detail);
  h.dirty();
  h.active(false);
  history.back();
  await waitFor(() => expect(h.traversals()).toBeGreaterThanOrEqual(2));
  expect(location.hash).toBe(detail);
  expect(h.visible()).toBe(detail);
  expect(h.decisions).toHaveLength(0);
  h.active(true);
  h.navigation.resume();
  await waitFor(() => expect(h.decisions).toHaveLength(1));
  h.decisions[0].proceed();
  await waitFor(() => expect(h.visible()).toBe(list));
  expect(h.discards()).toBe(1);
});
it("account disposal invalidates pending decisions and old entry ownership", () => {
  const old = setup();
  old.dirty();
  old.navigation.navigate(detail);
  old.navigation.dispose();
  const fresh = setup("#subscriptions?profile=two&output=desktop");
  old.decisions[0].proceed();
  expect(fresh.visible()).toBe("#subscriptions?profile=two&output=desktop");
  const length = history.length;
  fresh.navigation.closeDetail();
  expect(location.hash).toBe("#subscriptions?profile=two");
  expect(history.length).toBe(length);
});
it("history contains only opaque proof and nonsensitive position, never profile/output or private list context", () => {
  const h = setup();
  h.navigation.navigate(detail);
  expect(Object.keys(history.state).sort()).toEqual([
    "routeweaverEntry",
    "routeweaverLineage",
    "routeweaverPosition",
  ]);
  expect(Number.isSafeInteger(history.state.routeweaverPosition)).toBe(true);
  const value = JSON.stringify(history.state);
  expect(value).not.toContain("phone");
  expect(value).not.toContain("one");
  expect(value).not.toContain("subscriptions");
});

it("suspension invalidates a hidden discard dialog and same-account recovery asks anew", () => {
  const h = setup();
  h.dirty();
  h.navigation.navigate(detail);
  h.active(false);
  h.navigation.suspend();
  h.decisions[0].proceed();
  expect(h.visible()).toBe(list);
  h.active(true);
  h.navigation.resume();
  expect(h.decisions).toHaveLength(2);
  h.decisions[0].proceed();
  expect(h.visible()).toBe(list);
  h.decisions[1].proceed();
  expect(h.visible()).toBe(detail);
  expect(h.discards()).toBe(1);
});
it("a fresh controller inherits positional proof and cancels old-account traversal without truncating Forward", async () => {
  const old = setup();
  old.navigation.navigate(detail);
  old.navigation.dispose();
  let visible = detail;
  let decision: { proceed(): void; cancel(): void } | undefined;
  const fresh = createWorkspaceHistory({
    isDirty: () => true,
    confirm: (proceed, cancel) => {
      decision = { proceed, cancel };
    },
    accept: (hash) => {
      visible = hash;
    },
  });
  dispose = fresh.dispose;
  const length = history.length;
  const proof = history.state;
  history.back();
  await waitFor(() => expect(decision).toBeDefined());
  expect(history.state).toEqual(proof);
  expect(history.length).toBe(length);
  decision!.cancel();
  expect(visible).toBe(detail);
  expect(location.hash).toBe(detail);
});
it("legacy hash consumers receive accepted navigation but never unresolved dirty traversal", async () => {
  const h = setup();
  let raw = 0;
  let accepted = 0;
  const onRaw = () => {
    raw++;
  };
  const onAccepted = () => {
    accepted++;
  };
  window.addEventListener("hashchange", onRaw);
  window.addEventListener("routeweaver:navigation", onAccepted);
  try {
    h.navigation.navigate(detail);
    h.dirty();
    history.back();
    await waitFor(() => expect(h.decisions).toHaveLength(1));
    expect(raw).toBe(1);
    expect(accepted).toBe(1);
    h.decisions[0].cancel();
    expect(h.visible()).toBe(detail);
    expect(accepted).toBe(1);
  } finally {
    window.removeEventListener("hashchange", onRaw);
    window.removeEventListener("routeweaver:navigation", onAccepted);
  }
});
it("a multi-entry Back is restored without overwriting intervening entries", async () => {
  const h = setup();
  h.navigation.navigate(detail);
  h.navigation.navigate("#sources");
  h.dirty();
  history.go(-2);
  await waitFor(() => expect(h.decisions).toHaveLength(1));
  expect(location.hash).toBe("#sources");
  h.decisions[0].proceed();
  await waitFor(() => expect(h.visible()).toBe(list));
  history.forward();
  await waitFor(() => expect(h.visible()).toBe(detail));
  history.forward();
  await waitFor(() => expect(h.visible()).toBe("#sources"));
});
it("unknown Back asks before any write; choosing to keep edits explicitly replaces Forward with a new return entry", async () => {
  history.replaceState(null, "", "#sources");
  history.pushState(null, "", list);
  const h = setup();
  h.navigation.navigate(detail);
  h.dirty();
  const length = history.length;
  history.go(-2);
  await waitFor(() => expect(h.decisions).toHaveLength(1));
  expect(location.hash).toBe("#sources");
  expect(history.state).toBeNull();
  expect(h.decisions[0].unowned).toBe(true);
  expect(history.length).toBe(length);
  expect(h.visible()).toBe(detail);
  h.decisions[0].cancel();
  expect(location.hash).toBe(detail);
  expect(h.visible()).toBe(detail);
  expect(history.length).toBe(length - 1);
  expect(h.discards()).toBe(0);
});
it("inactive unknown traversal waits without a hidden dialog or history write; discard preserves Forward", async () => {
  history.replaceState(null, "", "#sources");
  history.pushState(null, "", list);
  const h = setup();
  h.navigation.navigate(detail);
  h.dirty();
  h.active(false);
  const length = history.length;
  history.go(-2);
  await waitFor(() => expect(h.traversals()).toBeGreaterThanOrEqual(1));
  expect(h.decisions).toHaveLength(0);
  expect(location.hash).toBe("#sources");
  expect(history.state).toBeNull();
  expect(history.length).toBe(length);
  expect(h.visible()).toBe(detail);
  h.active(true);
  h.navigation.resume();
  expect(h.decisions).toHaveLength(1);
  expect(h.decisions[0].unowned).toBe(true);
  h.decisions[0].proceed();
  expect(h.visible()).toBe("#sources");
  expect(h.discards()).toBe(1);
  expect(history.length).toBe(length);
  history.forward();
  await waitFor(() => expect(h.visible()).toBe(list));
  history.forward();
  await waitFor(() => expect(h.visible()).toBe(detail));
  expect(h.decisions).toHaveLength(1);
});
it("suspend destroys only the owned confirmation handle and invalidates its callbacks", () => {
  history.replaceState(null, "", list);
  let closes = 0;
  let accepts = 0;
  let staleProceed = () => {};
  const navigation = createWorkspaceHistory({
    isDirty: () => true,
    confirm: (proceed) => {
      staleProceed = proceed;
      return {
        destroy: () => {
          closes++;
        },
      };
    },
    accept: () => {
      accepts++;
    },
  });
  dispose = navigation.dispose;
  navigation.navigate(detail);
  navigation.suspend();
  expect(closes).toBe(1);
  staleProceed();
  expect(accepts).toBe(0);
  expect(location.hash).toBe(list);
});
it("each accepted Back/Forward notifies legacy hash consumers once, without treating synthetic events as browser trusted", async () => {
  const h = setup();
  const notifications: HashChangeEvent[] = [];
  const listener = (event: HashChangeEvent) => {
    notifications.push(event);
  };
  window.addEventListener("hashchange", listener);
  try {
    h.navigation.navigate(detail);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].isTrusted).toBe(false);
    history.back();
    await waitFor(() => expect(h.visible()).toBe(list));
    expect(notifications).toHaveLength(2);
    history.forward();
    await waitFor(() => expect(h.visible()).toBe(detail));
    expect(notifications).toHaveLength(3);
    expect(new URL(notifications[2].oldURL).hash).toBe(list);
    expect(new URL(notifications[2].newURL).hash).toBe(detail);
  } finally {
    window.removeEventListener("hashchange", listener);
  }
});
it("local view replacement keeps the same position without publishing or reconfirming, and Back restores its latest hash", async () => {
  const h = setup("#published-routes");
  h.dirty();
  const position = history.state.routeweaverPosition;
  const length = history.length;
  let notifications = 0;
  const listener = () => {
    notifications++;
  };
  window.addEventListener("hashchange", listener);
  try {
    h.navigation.bindView("#published-routes")("#published-routes?line=one");
    expect(location.hash).toBe("#published-routes?line=one");
    expect(history.state.routeweaverPosition).toBe(position);
    expect(history.length).toBe(length);
    expect(h.decisions).toHaveLength(0);
    expect(notifications).toBe(0);
    h.navigation.navigate("#sources");
    h.decisions[0].proceed();
    history.back();
    await waitFor(() => expect(h.visible()).toBe("#published-routes?line=one"));
  } finally {
    window.removeEventListener("hashchange", listener);
  }
});
it("a local view callback cannot overwrite a newer scope or a page left and later revisited", async () => {
  const h = setup("#published-routes");
  const late = h.navigation.bindView("#published-routes");
  h.navigation.navigate("#sources");
  history.back();
  await waitFor(() => expect(h.visible()).toBe("#published-routes"));
  late("#published-routes?line=stale");
  expect(location.hash).toBe("#published-routes");
  const earlier = h.navigation.bindView(location.hash);
  h.navigation.bindView(location.hash)("#published-routes?line=new");
  earlier("#published-routes?line=stale");
  expect(location.hash).toBe("#published-routes?line=new");
});
