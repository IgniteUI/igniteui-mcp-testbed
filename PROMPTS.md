# Predefined Test Prompts

A curated collection of prompts for testing Ignite UI app generation across frameworks.
Add new prompts here as useful test cases are discovered.

---

## Categories

- [Data & Charts](#data--charts)
- [Forms & Authentication](#forms--authentication)

---

## Data & Charts

### P-01 · Sales Dashboard with Grid + Chart

> **Focus:** Data grid capabilities, ApexCharts integration, real-world data layout

```
Create a single-page dashboard using Ignite UI components. Add an Ignite UI data grid with
realistic sales/order data suitable for charting. Enable Excel-style filtering, sorting,
column pinning, column hiding, column moving, column resizing, row selection, summaries,
grouping, row editing, and row action buttons. On the same page, add an ApexCharts line
chart that uses the same grid data and updates/corresponds to the dataset. Keep the page
clean, simple, and well styled.
```

**Expected coverage:**
- `IgxGrid` / `igc-grid` with advanced features (filter, sort, pin, hide, move, resize, select, summaries, grouping, row-edit)
- Row action buttons
- ApexCharts `line` chart driven by the same dataset
- Single-page layout, clean styling

---

## Forms & Authentication

### P-02 · Two-Page Authentication UI

> **Focus:** Breadth of Ignite UI form components, validation, responsive layout

```
Create a simple two-page authentication UI using Ignite UI components. Page one is a rich,
full-featured login form; page two is a rich, full-featured register form. Make the forms
intentionally complete, with multiple fields and options, so the usage of many Ignite UI
form components is clearly demonstrated. Use Ignite UI components: inputs, checkboxes,
radio buttons, switches, select, multi combo, links, buttons, and icons. Include validation
states, helper text, social login buttons, password visibility toggle, remember-me option,
terms/privacy agreement, and a clean responsive layout. Do not use plain HTML controls when
an Ignite UI component is available.
```

**Expected coverage:**
- `IgxInput` / `igc-input` (text, email, password with visibility toggle)
- `IgxCheckbox` / `igc-checkbox` (remember-me, terms/privacy)
- `IgxRadioGroup` / `igc-radio-group` + `igc-radio`
- `IgxSwitch` / `igc-switch`
- `IgxSelect` / `igc-select`
- `IgxCombo` / `igc-combo` (multi-select)
- `IgxButton` / `igc-button` + `IgxIcon` / `igc-icon`
- Validation states and helper/error text
- Social login buttons
- Two-page routing (Login → Register)

---

## Full Mordor Application

> **Focus:** Complex data management, hierarchical org chart, multi-source reporting

```
I'm Sauron, the Dark Lord, and I want to create an application to manage Mordor, and the puppet states I control, like Isengard. Even though I have no intention of invading the Middle Earth, I want to be able to get quick reports from my generals, to have an overview of the battalions they control, their numbers, morale, health and what is the primary race of soldiers they consist of. I want to have an org chart of my generals and lieutenants. I also want to keep track of my food suppliers availability and food production, my armory suppliers and smithing production by location. Also I want quick access to my spy network reports with highlights of items regarding the One Ring.
```

**Expected coverage:**
- Complex data management and reporting
- Hierarchical org chart
- Multi-source data integration (generals, suppliers, spies)

## Contributing

When adding a new prompt:

1. Choose or create an appropriate category section.
2. Assign the next sequential ID (`P-03`, `P-04`, …).
3. Write a short title and a `> Focus:` line summarising what the prompt tests.
4. Paste the prompt verbatim inside a fenced code block so copy-paste is clean.
5. List the **Expected coverage** — components or features the generated app should exercise.
