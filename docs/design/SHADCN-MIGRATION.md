# Official shadcn migration — 2026-10-29

## Provenance and design contract

The latest explicit user instruction supersedes the former Ant Design preference. The application now uses official **shadcn/ui radix-nova**, neutral semantic tokens, Geist, Tailwind v4, lucide-react and Radix accessibility primitives. `components.json` records aliases, style and registry configuration. Official references: https://ui.shadcn.com/docs/installation/vite, https://ui.shadcn.com/docs/installation/manual, https://ui.shadcn.com/docs/components, https://ui.shadcn.com/docs/forms/react-hook-form and https://ui.shadcn.com/docs/components/data-table.

Components were generated using installed official `shadcn@4.23.0` CLI:

```
node node_modules/shadcn/dist/index.js init --template vite --base radix --preset nova --yes --no-reinstall
node node_modules/shadcn/dist/index.js add <component names> --yes
```

Installation used npm's configured registry and the environment's approved HTTPS proxy; the initial stale localhost SOCKS setting failed without executing an install. Cache was redirected to the writable workspace. No GitHub authentication, production credentials or network policy bypass was used. Lockfile records resolved packages and integrity metadata.

The registry generated the components listed below. Local integration adaptations: Dialog, Sheet, AlertDialog, Select, DropdownMenu, Popover and Tooltip portals use `usePortalHost()` to stay inside their owning session workspace, preventing concealed-session content from leaking into `document.body`. AccordionContent additionally places the force-mounted closed-state hiding utility on the outer Radix content (where data-state lives), while retaining mounted field values. Its inner content uses natural height rather than the registry’s measured-height utility so dynamic form rows can grow/shrink after opening; the outer official animation remains unchanged. Light muted/destructive semantic tokens receive minimal in-gamut contrast adjustments for meaningful small text and tinted status labels; the official layout/style remains intact. All other normal component styling and accessible primitives remain official. Semantic application compositions (form fields, task dialogs, resource choices, notices, actions) use these components directly; no Ant Design alias/shim exists.

## Forms and task behavior

The existing nonvisual `@rc-component/form` state/validation engine is retained deliberately, independently of Ant Design. This preserves mature nested field, validation, dirty-draft and asynchronous submission contracts. `AppField` renders official Field/FieldLabel/FieldDescription/FieldError and explicitly maps native/Radix events; no custom visual framework substitutes for shadcn. Editable accordion content remains mounted but hidden while closed so advanced saved values participate in submit without opening it. Explicit protocol normalization strips only incompatible intent. PasswordInput composes official InputGroup with an accessible reveal control.

TaskDialog/TaskSheet/confirmation use Radix focus scopes and explicit task ownership. Pending controls retain focus only where existing task contracts require it, while duplicate writes remain guarded. Session-local portals and the innermost notification host keep private overlays concealed during reauthentication. Reduced-motion respects system preferences globally; standard component transitions provide subtle motion.

DataTable composes official shadcn Table/Checkbox/Button with TanStack Table v9 row models for sorting, selection, pagination and pinning. React Flow retains its official stylesheet for graph-library integration; application layout uses Tailwind tokens rather than the retired 2,872-line stylesheet.

## Endpoint role boundaries

Shared `ConnectionFields` exposes SOCKS5, Shadowsocks, VLESS, Trojan and VMess AEAD only where their capabilities allow them; managed-Xray accounting listeners are VLESS-only and remain TCP/ordinary-TLS constrained. Request headers and gRPC authority are outbound-only. Imported unsupported listener values remain visibly registered until explicit correction, never silently dropped. A sing-box WebSocket listener's existing Host is retained as a clearly labelled **client dial template**, not advertised as listener enforcement. Client public TLS values remain separate from server certificate/private-key ownership. Known Xray REALITY targets allow TCP/gRPC, not WebSocket/HTTP Upgrade or explicit ALPN; ordinary TLS and other target matrices remain distinct. VMess listener ciphers are auto-only. Imported incompatible values remain visible and require explicit correction rather than normalization that silently discards them.

## Verification boundaries

Focused Vitest suites and TypeScript/build checks are recorded in the parent verification logs. Browser specifications now observe official roles/data slots and the real Sidebar Collapsible navigation; test discovery is not browser execution. Actual cloud-browser geometry, keyboard and modal ownership reviews were completed separately; native Chromium automation remained blocked before assertions. Final repaired frontend acceptance is 1,796 passing tests plus typecheck/build; see `../verification/WIP47-FINAL.md`. Historic CSS readability assertions are migrated to semantic-token contrast checks rather than waived.

## Registry file snapshot

Hashes below describe the installed, minimally integrated local files, not an assertion that local portal adaptations are byte-identical to upstream.

| File | SHA-256 |
| --- | --- |
| `accordion.tsx` | `3745a881178cbe22ca1a4d2596cbd09fd0cc0e0b5e98293565e50a55826b8a42` |
| `alert-dialog.tsx` | `6b57b58fc93c2ba2f29229e6d088f6f4bf8b6fe97da114f27cea4d2ebcacb291` |
| `alert.tsx` | `f253568242c1c69b343f12474002fdbe229f603158171c59e21c491ab79f2e6e` |
| `avatar.tsx` | `036b8f39d9f42962a9eedd097103c90450d58a50ea55c693896c4cea4b5953a4` |
| `badge.tsx` | `59953420d01d23d172b4e32583426db153ff09226e2d460d53526b9f25282801` |
| `breadcrumb.tsx` | `0a8bde9cce18e08b8189d86eec603709c6ffa04238f062875685b90a44037154` |
| `button.tsx` | `08e5f87833c5db8436e89337ebde0f776bcdbf649d3de69fb89be6441ca2e366` |
| `calendar.tsx` | `b6955eb551738356d3c9928d4ba5522614b3458e1fee268863a7a12d3bdacc93` |
| `card.tsx` | `8ad3a18d36bda0598dc0e9aa96ea22854944d5443ee4946f1d173815e115375f` |
| `checkbox.tsx` | `0241c7d2b3723789f4ac40278c150b1b9960ad551a3f1a356fefd1f9f4ffd8ed` |
| `collapsible.tsx` | `c6598e5584f4258b5d9fefadbc5ad6a66888ad58729f4b634a0bb2d9c513188b` |
| `command.tsx` | `ebab598d42025fcc0eca7f75af29a43d1fcfd0250c3a40f2534a12af4768af70` |
| `dialog.tsx` | `e0905d3b088043f1ccf7b0917eeff58d1690e047df8fa2280746bc6f94f7ed83` |
| `dropdown-menu.tsx` | `37d5b3f694a64bbd323ddbd0ff4ad5844aa50c490751b02bd1821181f5f91070` |
| `empty.tsx` | `1280f9207787f9e7c219f7181459387b5e103606b6d91872de33a7a9752ee7a7` |
| `field.tsx` | `d7c372e8df76de0b4714c02497fefba29299e6baefb7c12fba289a2a374362bb` |
| `input-group.tsx` | `c8753d5bc132f180454c7b9f582bd9007e54bb8cae9d3ab4a545872dbb0fde8b` |
| `input.tsx` | `75418e030b2a54dd017ac0f4588db4bbdbabca7525e88bbc9d84cb3e18bcb905` |
| `label.tsx` | `344bde38b8531615dbf8e14af3895517c24d8ef6ce56ddeda7e2e6fe4b5d0c00` |
| `native-select.tsx` | `93262e9e6c108df664725a0043f0c06ef844e173088b18c0f807e753e2f86d22` |
| `pagination.tsx` | `70c3dbfd2e58c88d87f8f073dcd4925d0e015c401f61720e71bb9aa3ab40f503` |
| `popover.tsx` | `667c2621a4c8e344b33440cfa4c1392c02bbb20f34afa40e4e2fb800bbd8bbdc` |
| `progress.tsx` | `11470bfbc6c80a4b198a1c00b6ea6300f5b29990fdd2ac36921d1f30eb2d4aa4` |
| `radio-group.tsx` | `e97775aa292979393ebd4ffd53385b60e71511daa80a11fcfad0ec16d017e0e0` |
| `scroll-area.tsx` | `436777583f300e9fb0ca9df97ce9d1ca45443b7513273f39d27c6183b99db396` |
| `select.tsx` | `a011f707a9df77dfc72e0c3045d34b89580b6f75177a4fbb30b41f2dd885ce1a` |
| `separator.tsx` | `b5b5460e5337c2d5f361c1512001615b2e5eacb38c7449a4418bb9ddb47c4bba` |
| `sheet.tsx` | `7b7808d694ba67798066563c001b1f9201851313e081d387f9b46ff072bacf02` |
| `sidebar.tsx` | `a0ebdc2eecc0ac620d56b77b30bc059d5a1f3c77e614586e45a73dfc31b55851` |
| `skeleton.tsx` | `4c2af7fa9c645358a0fb188779deab6f0b981733b62befc25e18aaebea1350dc` |
| `sonner.tsx` | `0c729f9f1ada0b0bedd9296710cc257dc43559fa6b8cc40f010d129e8ff85fdd` |
| `spinner.tsx` | `6916679a40ad1c7624520de5eaa7b337635e81f9a76413201267f8619844646f` |
| `switch.tsx` | `afd5b6e6b9c2bcd42ee164a39ca18c342b2d7a2dfedd29da3065dc37021090e8` |
| `table.tsx` | `300dc171ff0e09543dce0787f43a3ceb0d168fa800eaecb98b6c5630f3c6d7e9` |
| `tabs.tsx` | `b977274550595594055d850a16775c75761765e1cd76b4827e101c2f432762df` |
| `textarea.tsx` | `82601c91ffc6c727d924162c78d7cb853114bcced4e2eb922a68ca12d4239c0f` |
| `toggle.tsx` | `aafa82253550574c833d0072c9f6f4a71e36efdbbeddb8ddf1b09db1fbc1f621` |
| `tooltip.tsx` | `87313c98b3242834168a428732d91b9790198001ebef80416676aca82f53ad2e` |

## WIP48 composed-UI refinement (2026-10-30)

The Dialog, Sheet and AlertDialog overlay primitives retain the official Nova structure, focus behavior and motion classes. Their overlay color is explicitly customized from `bg-black/10` with `backdrop-blur-xs` to `bg-black/25` without blur. Actual long-form review found the blurred workspace visually distracting behind a divider-heavy form; a uniform scrim preserves context while making the foreground task clear. This is a bounded registry customization, not unchanged upstream output. Task titles use an 18px semibold hierarchy, and header/footer spacing is smaller than body spacing; mobile actions retain 44px minimum height.

Untitled list sections may explicitly opt into `Section variant="plain"` to avoid an extra card around an already bordered table. Default card sections remain available for genuinely grouped content. Shared page headings rely on the workspace's existing section spacing rather than adding a second bottom gap. Primary subscription/network destinations are visible by default but their groups remain collapsible. These composition decisions are project-specific, informed by the official Sidebar, Field and Data Table examples; using the primitives alone does not establish visual quality.
