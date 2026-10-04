import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import adminRouter from "./admin";
import storageRouter from "./storage";
import authRouter from "./auth";
import dashboardUsersRouter from "./dashboard-users";
import newsRouter from "./news";
import suggestionsRouter from "./suggestions";
import siteRouter from "./site";
import oauthRouter from "./oauth";
import adminSiteRouter from "./admin-site";
import activityRouter from "./activity";
import emojiAdminRouter from "./emoji-admin";
import unbelievaboatAdminRouter from "./unbelievaboat-admin";
import badgesAdminRouter from "./badges-admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(siteRouter);
router.use("/auth", authRouter);
router.use("/oauth", oauthRouter);
router.use("/activity", activityRouter);
router.use("/dashboard/users", dashboardUsersRouter);
router.use("/admin", adminSiteRouter);
router.use("/admin", emojiAdminRouter);
router.use("/admin", unbelievaboatAdminRouter);
router.use("/admin", badgesAdminRouter);
router.use("/admin", adminRouter);
router.use(storageRouter);
router.use(newsRouter);
router.use(suggestionsRouter);
router.use(dashboardRouter);

// NOTE: The /embeds, /rarity-profiles, /custom-rarities, /card-rarity-overrides
// routers used to live here. They were unmounted in May 2026 as part of the
// website/Discord separation — those endpoints wrote per-guild gameplay
// configuration that now belongs exclusively to the Discord bot. The router
// files remain in this folder for one release in case we need a quick
// rollback, but nothing routes to them and they are not imported.

export default router;
