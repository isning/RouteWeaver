# Client editor tab panels

## Finding

Actual desktop accessibility-tree review found empty tabpanel containers. The corresponding input/group/rule/runtime controls were rendered outside the Ant Design Tabs component. Visual switching worked, but the tab's accessible content relationship was incorrect.

## Fix

Render the existing sections as each library tab item's children. Keep the rules-resource error within its rules panel. Use destroyOnHidden to preserve the prior unmounted-inactive-panel behavior; the draft remains owned by ProfileEditor. Keep the summary and navigation visually grouped without creating a second tab system or changing domain state.

Also make profile card counts and update time use the existing readable secondary text color, and raise the 10 px update time to 12 px.

## Evidence

- New public DOM regression failed before the fix because the input panel contained no heading or controls; it now checks all four named tab panels and a single visible active panel.
- Focused suite: 3 files / 45 tests passed, typecheck/build passed. A requested nonexistent native-override test path matched no file and is not counted as coverage; native override flows live in the workspace suite and are included in the full Web gate.
- Actual desktop AX tree now nests controls within the corresponding named panel. ArrowRight moves focus from input to strategy groups, with visible focus; Enter activates the group panel. This checks browser semantics/keyboard interaction, not a complete screen-reader speech audit.
- Desktop visual grouping remains consistent with the previous layout. No profile was saved or published during this check.
- Full Web gate and narrow-screen follow-up remain pending until recorded below.

Narrow follow-up: actual CSS client/scroll width both 375. All four tabs remain visible and the page does not horizontally overflow. The first pass exposed a responsive cascade issue: generic .surface rules restored 20 px margin and rounded bottom corners between the summary and its tab strip. Keep that as an open layout fix until the current serialized suite finishes; do not call the first narrow pass visually complete.

Final verification:
- Full Web gate passed: 29 files / 277 tests, 157.32 seconds; production build passed (`/tmp/profile-editor-web-regression.log`).
- After the responsive-only cascade fix, focused tab/readability regressions (30 tests), typecheck/build passed (`/tmp/profile-responsive-final.log`).
- Actual 375 px follow-up confirms clientWidth=scrollWidth=375, summary margin-bottom/padding-bottom/bottom radius all 0; the form summary and navigation now remain one visual group. All four tab labels fit without clipping.
