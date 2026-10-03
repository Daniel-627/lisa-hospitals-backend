import { Request, Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, newsPosts } from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { handleError } from "../utils/errors";

// Public endpoints: published posts only. Writing/editing posts comes with the admin panel.
const SLUG = /^[a-z0-9][a-z0-9-]{0,299}$/;

export const getPublishedPosts = async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "12"), 10) || 12, 1), 50);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

    const posts = await db
      .select({
        id: newsPosts.id, title: newsPosts.title, slug: newsPosts.slug,
        excerpt: newsPosts.excerpt, coverImage: newsPosts.coverImage, publishedAt: newsPosts.publishedAt,
      })
      .from(newsPosts)
      .where(eq(newsPosts.isPublished, true))
      .orderBy(desc(newsPosts.publishedAt))
      .limit(limit)
      .offset(offset);

    res.set("Cache-Control", "public, max-age=60");
    return sendSuccess(res, posts);
  } catch (err) {
    return handleError(res, err, "getPublishedPosts");
  }
};

export const getPostBySlug = async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    if (!SLUG.test(slug)) return sendError(res, "Article not found", 404);

    const [post] = await db
      .select({
        id: newsPosts.id, title: newsPosts.title, slug: newsPosts.slug, excerpt: newsPosts.excerpt,
        body: newsPosts.body, coverImage: newsPosts.coverImage, publishedAt: newsPosts.publishedAt,
      })
      .from(newsPosts)
      .where(and(eq(newsPosts.slug, slug), eq(newsPosts.isPublished, true)))
      .limit(1);

    if (!post) return sendError(res, "Article not found", 404);
    res.set("Cache-Control", "public, max-age=60");
    return sendSuccess(res, post);
  } catch (err) {
    return handleError(res, err, "getPostBySlug");
  }
};
