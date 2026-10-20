import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  Clock,
  Tag,
  User,
} from "lucide-react";
import { JsonLd } from "@/components/marketing/json-ld";
import { Section } from "@/components/marketing/section";
import { Button } from "@/components/ui/button";
import {
  getAdjacentPosts,
  getPost,
  getPostSlugs,
  type BlogPostSummary,
} from "@/lib/blog";
import { marketingUrl } from "@/lib/marketing-routes";

/** Only the slugs in `content/blog` exist — anything else 404s (design D6). */
export const dynamicParams = false;

export function generateStaticParams() {
  return getPostSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return {};
  const canonical = marketingUrl(`/blog/${slug}`);

  return {
    title: post.title,
    description: post.description,
    alternates: {
      canonical,
    },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.description,
      url: canonical,
      publishedTime: post.date,
      authors: [post.author],
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
    },
  };
}

function PostMetaRow({ post }: { post: BlogPostSummary }) {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
      <span className="inline-flex items-center gap-1.5">
        <Calendar className="size-4" />
        <time dateTime={post.date}>
          {format(new Date(post.date), "MMMM d, yyyy")}
        </time>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <User className="size-4" />
        {post.author}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Clock className="size-4" />
        {post.readingMinutes} min read
      </span>
      {post.tags.length > 0 ? (
        <span className="inline-flex items-center gap-1.5">
          <Tag className="size-4" />
          {post.tags.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

function AdjacentPostCard({
  label,
  post,
  align,
}: {
  label: string;
  post: BlogPostSummary;
  align: "start" | "end";
}) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className={`group border-border bg-card hover:border-primary/40 flex flex-col rounded-2xl border p-6 transition-colors ${
        align === "end" ? "items-end text-right" : ""
      }`}
    >
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
        {align === "start" ? (
          <ArrowLeft className="size-4 transition-transform group-hover:-translate-x-0.5" />
        ) : null}
        {label}
        {align === "end" ? (
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        ) : null}
      </span>
      <span className="text-foreground group-hover:text-primary mt-2 font-semibold tracking-tight transition-colors">
        {post.title}
      </span>
    </Link>
  );
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();

  const { newer, older } = await getAdjacentPosts(slug);
  const canonical = marketingUrl(`/blog/${slug}`);

  return (
    <article>
      {/* Article header */}
      <Section spacing="sm" containerSize="prose" className="pb-0">
        <nav
          aria-label="Breadcrumb"
          className="text-muted-foreground mb-8 flex flex-wrap items-center gap-2 text-sm"
        >
          <Link href="/" className="hover:text-foreground transition-colors">
            Home
          </Link>
          <span aria-hidden>/</span>
          <Link
            href="/blog"
            className="hover:text-foreground transition-colors"
          >
            Blog
          </Link>
          <span aria-hidden>/</span>
          <span className="text-foreground truncate">{post.title}</span>
        </nav>
        <h1 className="text-foreground text-h1 font-bold tracking-tight">
          {post.title}
        </h1>
        <p className="text-muted-foreground mt-5 text-lg leading-relaxed">
          {post.description}
        </p>
        <div className="mt-6">
          <PostMetaRow post={post} />
        </div>
      </Section>

      {/* MDX body — styled by the scoped .prose-blog class (design D6/D7) */}
      <Section spacing="sm" containerSize="prose">
        <div className="prose-blog">
          <post.Content />
        </div>
      </Section>

      {/* Prev/next navigation */}
      {older || newer ? (
        <Section spacing="sm" containerSize="wide">
          <div className="grid gap-4 sm:grid-cols-2">
            {older ? (
              <AdjacentPostCard
                label="Previous article"
                post={older}
                align="start"
              />
            ) : (
              <span aria-hidden />
            )}
            {newer ? (
              <AdjacentPostCard label="Next article" post={newer} align="end" />
            ) : (
              <span aria-hidden />
            )}
          </div>
        </Section>
      ) : null}

      {/* CTA */}
      <Section spacing="sm" containerSize="narrow">
        <div className="from-primary/5 to-accent-warm/5 border-primary/15 rounded-2xl border bg-gradient-to-br p-8 text-center sm:p-10">
          <h2 className="text-h3 text-foreground font-bold tracking-tight">
            Keep a copy of the pages you can&rsquo;t afford to lose
          </h2>
          <p className="text-muted-foreground mx-auto mt-3 max-w-md">
            PagePocket saves full-fidelity pages to a private, searchable
            library you can share with a link. Free to start.
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href="/register" />}
              className="bg-accent-warm text-accent-warm-foreground hover:bg-accent-warm/90"
            >
              Save your first page
            </Button>
            <Button
              size="lg"
              variant="outline"
              nativeButton={false}
              render={<Link href="/features" />}
            >
              See how it works
            </Button>
          </div>
        </div>
      </Section>

      <JsonLd
        data={[
          {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            headline: post.title,
            description: post.description,
            datePublished: post.date,
            dateModified: post.date,
            author: { "@type": "Organization", name: post.author },
            publisher: {
              "@type": "Organization",
              name: "PagePocket",
              url: marketingUrl("/"),
            },
            // NOTE: no `image` field — Next 16 emits metadata image routes
            // with a content-hash path suffix (e.g. /opengraph-image-yqks0s)
            // that isn't knowable at build time here; the og:image / twitter
            // image <meta> tags on this page carry the per-post image.
            mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
            url: canonical,
          },
          {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              {
                "@type": "ListItem",
                position: 1,
                name: "Home",
                item: marketingUrl("/"),
              },
              {
                "@type": "ListItem",
                position: 2,
                name: "Blog",
                item: marketingUrl("/blog"),
              },
              {
                "@type": "ListItem",
                position: 3,
                name: post.title,
                item: canonical,
              },
            ],
          },
        ]}
      />
    </article>
  );
}
