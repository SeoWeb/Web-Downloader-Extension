import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { JsonLd } from "@/components/marketing/json-ld";
import { FaqList, type FaqItem } from "@/components/marketing/faq-list";
import {
  ComparisonTable,
  type ComparisonColumn,
  type ComparisonRow,
} from "@/components/marketing/comparison-table";
import { Section } from "@/components/marketing/section";
import { PageHero } from "@/components/marketing/page-hero";

function getJsonLdScript(): HTMLScriptElement {
  const script = document.querySelector<HTMLScriptElement>(
    'script[type="application/ld+json"]',
  );
  expect(script).not.toBeNull();
  return script as unknown as HTMLScriptElement;
}

function parseJsonLdScript(): unknown {
  const script = getJsonLdScript();
  expect(script.textContent).toBeTruthy();
  return JSON.parse(script.textContent ?? "");
}

describe("JsonLd", () => {
  it("renders a single JSON-LD object as an application/ld+json script", () => {
    const data = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "PagePocket",
      url: "https://pagepocket.app",
    };
    const { container } = render(<JsonLd data={data} />);

    const script = getJsonLdScript();
    expect(script).toBeInTheDocument();
    expect(JSON.parse(script.textContent ?? "")).toEqual(data);
    // Nothing else is rendered — the script is the whole output.
    expect(container.childElementCount).toBe(1);
  });

  it("accepts an array of JSON-LD objects", () => {
    render(
      <JsonLd
        data={[
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            name: "PagePocket",
          },
          {
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: "PagePocket",
          },
        ]}
      />,
    );

    const parsed = parseJsonLdScript() as Array<{ "@type": string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.["@type"]).toBe("Organization");
    expect(parsed[1]?.["@type"]).toBe("WebSite");
  });

  it("escapes < so payloads cannot break out of the script element", () => {
    const hostile = "</script><script>alert(1)</script>";
    render(
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Thing",
          name: hostile,
        }}
      />,
    );

    const script = getJsonLdScript();
    // Raw serialized output must not contain a literal </script> sequence.
    expect(script.textContent).not.toContain("</script>");
    // …while the parsed JSON still round-trips to the original value.
    const parsed = JSON.parse(script.textContent ?? "") as { name: string };
    expect(parsed.name).toBe(hostile);
  });
});

describe("FaqList", () => {
  const faqs: FaqItem[] = [
    {
      question: "What browsers are supported?",
      answer:
        "PagePocket works on Chrome, Edge, Brave, and any Chromium-based browser.",
    },
    {
      question: "Is my archive private?",
      answer:
        "Yes — only you can read your saved pages unless you share a link.",
    },
    {
      question: "Can I search inside saved pages?",
      answer: "Every saved page is full-text indexed in your library.",
    },
  ];

  it("renders one collapsible <details> item per FAQ entry", () => {
    const { container } = render(<FaqList items={faqs} />);

    const items = container.querySelectorAll("[data-slot='faq-item']");
    expect(items).toHaveLength(faqs.length);
    expect(container.querySelectorAll("details")).toHaveLength(faqs.length);
    expect(container.querySelectorAll("summary")).toHaveLength(faqs.length);
  });

  it("emits FAQPage JSON-LD that matches the visible questions and answers", () => {
    render(<FaqList items={faqs} />);

    const parsed = parseJsonLdScript() as {
      "@context": string;
      "@type": string;
      mainEntity: Array<{
        "@type": string;
        name: string;
        acceptedAnswer: { "@type": string; text: string };
      }>;
    };

    expect(parsed["@context"]).toBe("https://schema.org");
    expect(parsed["@type"]).toBe("FAQPage");
    expect(parsed.mainEntity).toHaveLength(faqs.length);

    faqs.forEach((faq, i) => {
      const entity = parsed.mainEntity[i];
      expect(entity?.["@type"]).toBe("Question");
      expect(entity?.name).toBe(faq.question);
      expect(entity?.acceptedAnswer).toEqual({
        "@type": "Answer",
        text: faq.answer,
      });
    });
  });

  it("renders nothing (not even schema) when there are no items", () => {
    const { container } = render(<FaqList items={[]} />);

    expect(container.querySelector("details")).toBeNull();
    expect(
      container.querySelector('script[type="application/ld+json"]'),
    ).toBeNull();
  });
});

describe("ComparisonTable", () => {
  const columns: ComparisonColumn[] = [
    { id: "pagepocket", name: "PagePocket" },
    { id: "bookmarks", name: "Browser bookmarks" },
  ];

  const rows: ComparisonRow[] = [
    {
      feature: "Full-text search",
      values: { pagepocket: true, bookmarks: false },
    },
    {
      feature: "Where pages live",
      values: {
        pagepocket: "Private cloud library",
        bookmarks: "Local device only",
      },
    },
    {
      feature: "Team features",
      values: { pagepocket: false, bookmarks: undefined },
      note: "Team tier is not part of the launch plans.",
    },
  ];

  it("renders the feature header row and both product columns", () => {
    render(
      <ComparisonTable
        columns={columns}
        rows={rows}
        highlightColumn="pagepocket"
        caption="Feature comparison"
      />,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "PagePocket" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Browser bookmarks" }),
    ).toBeInTheDocument();
  });

  it("marks the highlight column's header and cells", () => {
    const { container } = render(
      <ComparisonTable
        columns={columns}
        rows={rows}
        highlightColumn="pagepocket"
      />,
    );

    const highlightedHeader = screen.getByRole("columnheader", {
      name: "PagePocket",
    });
    expect(highlightedHeader).toHaveAttribute("data-highlight");

    // Cells in the highlighted column carry the same marker; the others don't.
    const highlightedCells = container.querySelectorAll("td[data-highlight]");
    expect(highlightedCells).toHaveLength(rows.length);
    const unhighlightedHeader = screen.getByRole("columnheader", {
      name: "Browser bookmarks",
    });
    expect(unhighlightedHeader).not.toHaveAttribute("data-highlight");
  });

  it("renders no highlight when highlightColumn is omitted", () => {
    const { container } = render(
      <ComparisonTable columns={columns} rows={rows} />,
    );

    expect(container.querySelector("[data-highlight]")).toBeNull();
  });

  it("renders booleans as check/x icons with accessible labels", () => {
    render(
      <ComparisonTable
        columns={columns}
        rows={rows}
        highlightColumn="pagepocket"
      />,
    );

    // pagepocket:true in row 1 → exactly one "Included"
    expect(screen.getAllByText("Included")).toHaveLength(1);
    // pagepocket:false in row 3 + bookmarks:false in row 1 → two "Not included"
    expect(screen.getAllByText("Not included")).toHaveLength(2);
  });

  it("renders string cells, em-dash placeholders, and note rows", () => {
    render(
      <ComparisonTable
        columns={columns}
        rows={rows}
        highlightColumn="pagepocket"
      />,
    );

    expect(screen.getByText("Private cloud library")).toBeInTheDocument();
    expect(screen.getByText("Local device only")).toBeInTheDocument();
    // undefined → em dash with "Not applicable" for assistive tech
    expect(screen.getByText("Not applicable")).toBeInTheDocument();
    expect(
      screen.getByText(/Team tier is not part of the launch plans/),
    ).toBeInTheDocument();
  });
});

describe("Section / PageHero primitives", () => {
  it("Section renders its header as an h2 with eyebrow and subtitle", () => {
    render(
      <Section
        eyebrow="How it works"
        title="Three steps to your archive"
        subtitle="From tab to archive in seconds."
      >
        <p>Section body</p>
      </Section>,
    );

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Three steps to your archive",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("How it works")).toBeInTheDocument();
    expect(
      screen.getByText("From tab to archive in seconds."),
    ).toBeInTheDocument();
    expect(screen.getByText("Section body")).toBeInTheDocument();
  });

  it("Section renders children only when no header props are given", () => {
    const { container } = render(
      <Section>
        <p>Just content</p>
      </Section>,
    );

    expect(container.querySelector("h2")).toBeNull();
    expect(screen.getByText("Just content")).toBeInTheDocument();
  });

  it("PageHero renders an h1 with eyebrow, lede, and actions", () => {
    render(
      <PageHero
        eyebrow="Private web archiving"
        title="Your private Wayback Machine"
        lede="Save any page in full fidelity, search it forever, share it with a link."
        actions={<button type="button">Start free</button>}
      />,
    );

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Your private Wayback Machine",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Private web archiving")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start free" }),
    ).toBeInTheDocument();
  });
});
