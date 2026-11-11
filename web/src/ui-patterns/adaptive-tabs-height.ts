// App composition only: preserve compact primitive defaults while permitting
// text-relative minimum sizing. Actual geometry requires native-browser checks.
export const adaptiveTabsHeight =
  "min-h-min [&>[data-slot=tabs-trigger]]:min-h-[1lh]";
