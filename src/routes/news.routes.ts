import { Router } from "express";
import { getPublishedPosts, getPostBySlug } from "../controllers/news.controller";

export const newsRoutes = Router();

// Public — no auth needed
newsRoutes.get("/",      getPublishedPosts);
newsRoutes.get("/:slug", getPostBySlug);
