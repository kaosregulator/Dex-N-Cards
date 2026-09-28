import { Client, GatewayIntentBits, Partials, Events, REST, Routes, ApplicationCommandType, type Interaction } from "discord.js";
import { logger } from "../lib/logger.js";
import { BRAND_NAME } from "./help-banners.js";
import {
  burnCard, getOrCreateCurrency, getAllCards, getAllCardsCached,
  getRarityContext, applyRarityContextAll, effectiveRarityKey,
} from "./db.js";
import { toAbsoluteImageUrl } from "./image-url.js";
import { rarityColor } from "./cards-data.js";
import { runIsolationSelfCheck } from "./isolation-check.js";
import { handleEditCardSelect, handleEditCardModal } from "./commands/edit-card.js";
import { handleEditImageButton, handleEditImageModal, handleEditImagePick } from "./commands/edit-image.js";
import { handleTradeButton } from "./commands/trading.js";
import { initSpawnManager, initAllGuilds, handleCatchAttempt, handleClaimButtonClick, scheduleNextSpawn, buildPostDecisionEmbed, buildDisabledDecisionRow, markDecisionMade } from "./spawn-manager.js";
import { handleConfigButton, handleConfigSelect, handleRatesSelect, handlePacksSelect, handleRatesCustomModal, handleExperienceSelect } from "./commands/config-panel.js";
import { LAUNCH_PREFIX, handleExperienceLaunch } from "./experience.js";
import { handleSetsHubButton, handleSetsHubSelect, handleSetsHubModal } from "./commands/sets-panel.js";
import { handleSetAdminHubButton, handleSetAdminHubSelect, handleSetAdminHubWeightSelect, handleSetAdminHubModal } from "./commands/set-admin-hub.js";
import { handleRarityEditButton, handleRarityEditSelect, handleRarityEditModal, handleRarityHubButton, handleRarityHubSelect, handleRarityHubModal } from "./commands/rarity-admin.js";
import { handleSetChannelsPick, handleSetChannelsApply } from "./commands/setchannels.js";
import { handleAdminHubButton, handleAdminHubModal } from "./commands/admin-hub.js";
import { handleMttvHubButton, handleMttvHubModal, handleMttvHubSelect } from "./commands/mttcalc-hub.js";
import { handleMTTVCalcButton, handleMTTVCalcModal, handleMTTVCalcSelect } from "./commands/mttvalues.js";
import { checkAchievements, formatUnlockLine } from "./achievements.js";
import { handleAdminCommand } from "./commands/admin.js";
import { handleUserCommand } from "./commands/user.js";
import { handlePrefixCommand, getGuildPrefix, getGuildGamesPrefix } from "./commands/prefix.js";
import {
  handleSetupButton, handleSetupSelect, handleSetupModalSubmit,
} from "./commands/setup-wizard.js";
import { handleCardWizardStep, handleCardEditStep } from "./commands/card-wizard.js";
import { handleAutocomplete } from "./commands/autocomplete.js";
import { handleBattleCommand } from "./commands/battle.js";
import {
  handleBattleAdminCommand, handleBattleAdminButton, handleBattleAdminSelect,
  handleBattleAdminChannelSelect, handleBattleAdminModal,
} from "./commands/battle-admin.js";
import { handleBattleComponent, startBattleMaintenance } from "./battle/battle-manager.js";
import { handleMarketCommand } from "./market/commands.js";
import { startMarketMaintenance } from "./market/sweeper.js";
import { handleSquadCommand } from "./squad/commands.js";
import { handleRaidCommand } from "./raid/command.js";
import { handleRaidAdminCommand } from "./raid/admin.js";
import { handleRaidComponent } from "./raid/manager.js";
import { handleGiveawayHubCommand, handleGiveawayHubComponent } from "./giveaway/hub.js";
import { handleGiveawayComponent } from "./giveaway/manager.js";
import { handleGiveawayMessage } from "./giveaway/message-hook.js";
import { startGiveawayMaintenance } from "./giveaway/sweeper.js";
import { handleHelpHubComponent } from "./commands/help-hub.js";
import { buildBattleStatsEmbed, battleStatsLevelJumpRow } from "./battle/stats-view.js";
import { buildCardLevelEmbed } from "./cards/level-command.js";
import { handleWhisperCommand, handleAdminSecretCommand, handleEchoCommand } from "./secret/commands.js";
import { isSecretModal, handleSecretModal, isSecretButton, handleSecretButton } from "./secret/interactions.js";
import {
  buildCommands, USER_HUB_COMMANDS, ADMIN_HUB_COMMANDS, internalCommandName, HUB_REPLACED_COMMANDS,
} from "./commands/register.js";
import { MessageFlags, EmbedBuilder } from "discord.js";
import { createSetupLink } from "../lib/setup-link.js";
import { setBotClient } from "./client-holder.js";
// ── AFK Secretary & Whitelist Access System ──────────────────────────────────
import { handleAfkCommand, handleAfkSetupCommand } from "./afk/commands.js";
import { handleAfkInteraction } from "./afk/interactions.js";
import { handleAfkMessage } from "./afk/message-hook.js";
import { handleAfkPresence, startAfkSweeper } from "./afk/presence-hook.js";
// ── Quiet Mode / Quiet Room (addon) ──────────────────────────────────────────
import {
  handleQuietCommand, handleQuietSetupCommand,
  handleVacationCommand, handleLoaCommand,
} from "./quiet/commands.js";
import { handleQuietInteraction } from "./quiet/interactions.js";
import { startQuietRecovery } from "./quiet/recovery.js";
import { startQuietAudioPrebuild } from "./quiet/audio/generate.js";

export async function startBot() {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) { logger.error("DISCORD_BOT_TOKEN not set — bot will not start."); return; }

  const { HOME_GUILD_ID } = await import("./home-guild.js");
  if (!HOME_GUILD_ID) {
    logger.warn(
      "HOME_GUILD_ID is not set. Commands that mutate globally shared data " +
      "(addcard, editcard, removecard, import, /set_hub · /set_admin …) " +
      "will be blocked for ALL guilds until HOME_GUILD_ID is configured. " +
      "Set it to your home server's Discord guild ID in the environment variables.",
    );
  } else {
    logger.info({ homeGuildId: HOME_GUILD_ID }, "Tenant isolation active — global mutations restricted to home guild");
  }

  // --- Multi-instance guard ---
  // Discord allows only one gateway connection per token. If both the dev
  // workflow and the published deployment connect with the same token they
  // race and slash commands route to whichever is currently winning the
  // gateway lease. Default behaviour: only the published deployment connects
  // (Replit REPLIT_DEPLOYMENT=1, Railway RAILWAY_*, or DN_DEPLOYMENT=1).
  // Override in dev with FORCE_DISCORD_LOGIN=1 (use a separate dev token!).
  const { isPublishedDeployment, deploymentBuildId, deploymentProcessType, databaseHost } =
    await import("../lib/runtime-env.js");
  const isDeployment = isPublishedDeployment();
  const force = process.env["FORCE_DISCORD_LOGIN"] === "1";
  const processType = deploymentProcessType();
  const buildId = deploymentBuildId();
  const dbHost = databaseHost();
  logger.info(
    { processType, buildId, dbHost, isDeployment, willLogin: isDeployment || force },
    "Bot startup banner",
  );
  if (!isDeployment && !force) {
    logger.warn(
      "Skipping Discord login: this is a dev process and FORCE_DISCORD_LOGIN!=1. " +
      "The published deployment owns the bot token. On Railway this should auto-detect; " +
      "otherwise set DN_DEPLOYMENT=1. For local Discord E2E set FORCE_DISCORD_LOGIN=1 with a SEPARATE dev token.",
    );
    return;
  }

  // The AFK Secretary "On Status Change" trigger needs the privileged
  // GuildPresences intent. It's opt-in via AFK_PRESENCE_INTENT=1 because a
  // client that requests a privileged intent NOT enabled in the Developer
  // Portal fails login outright — we never want the AFK addon to take the whole
  // bot down. When unset, every other AFK feature still works; only the
  // status-change auto-clear is inert. Enable BOTH the env flag and the
  // "Presence Intent" toggle in the portal to turn it on.
  const afkPresenceEnabled = process.env["AFK_PRESENCE_INTENT"] === "1";
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ];
  if (afkPresenceEnabled) intents.push(GatewayIntentBits.GuildPresences);

  const client = new Client({
    intents,
    partials: [Partials.Channel],
  });

  initSpawnManager(client);
  setBotClient(client);

  client.once(Events.ClientReady, async (c) => {
    logger.info(
      {
        tag: c.user.tag,
        guildCount: c.guilds.cache.size,
        guildIds: [...c.guilds.cache.keys()],
        processType: deploymentProcessType(),
        buildId: deploymentBuildId(),
        pid: process.pid,
      },
      `${BRAND_NAME} bot ready`,
    );
    try {
      // Default 27-card roster is NOT auto-seeded — admins opt-in from `!setup`
      // ("Load Defaults" button) or set hubs (`/set_hub` / `/set_admin`). Keeps fresh
      // servers free to load only their own custom roster.
      await initAllGuilds(client);
      // Warm the progression (level) frame image cache so the synchronous draw
      // hooks find them ready on every render surface (battles, siege, raid, …).
      void (await import("./animations/card-frames.js")).preloadProgressionFrames().catch(() => {});
      // ⚠️ REPLIT SAFETY REVIEW ⚠️ Cross-server data-isolation canary. Read-only;
      // shouts in the logs ([ISOLATION]/[REPLIT]) if it spots orphaned cards, a
      // mass-deleted home roster, or cross-guild collection contamination.
      void runIsolationSelfCheck();
      // Boot-time backfill is no longer needed; sets are managed via the
      // first-class sets + card_set_memberships tables.
      startBattleMaintenance();
      startMarketMaintenance();
      startGiveawayMaintenance();
      await registerCommands(c.user.id, token, client);
      // AFK Secretary: start the timed auto-remove sweeper (clears "timed" AFKs
      // once their countdown elapses; presence/messages can't cover this).
      startAfkSweeper(client);
      // Quiet Mode: restore any in-progress Quiet Room sessions after restart
      // and warm the audio cache pool (non-blocking).
      startQuietRecovery(client);
      startQuietAudioPrebuild();
    } catch (err) {
      // Never let ClientReady reject into an unhandled 'error' event — that
      // crashes Node and Railway crash-loops (empty DB / missing tables).
      logger.error({ err }, "Bot ready handler failed — Discord stays connected; fix DB/schema and redeploy");
    }
  });

  // AFK Secretary: "On Status Change" trigger — clears AFK when a member flips
  // Offline/Idle → Online. Only wired when the GuildPresences intent is enabled
  // (AFK_PRESENCE_INTENT=1); otherwise presenceUpdate never delivers anyway.
  if (afkPresenceEnabled) {
    client.on(Events.PresenceUpdate, (oldPresence, newPresence) => {
      if (!newPresence) return;
      void handleAfkPresence(oldPresence, newPresence);
    });
  }

  client.on(Events.GuildCreate, async (guild) => {
    logger.info({ guildId: guild.id, name: guild.name }, "Bot joined guild");
    scheduleNextSpawn(guild.id);
    const rest = new REST().setToken(token);
    await rest
      .put(Routes.applicationGuildCommands(client.user!.id, guild.id), { body: buildCommands() })
      .catch(err => logger.error({ err, guildId: guild.id }, "Failed to register guild commands on join"));

    // DM the server owner a one-time dashboard setup link. Best-effort —
    // if their DMs are off, they can run /dashboard later.
    try {
      const owner = await guild.fetchOwner();
      const { url, expiresAt } = await createSetupLink({
        discordUserId: owner.id,
        guildId: guild.id,
        ttlHours: 72,
      });
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`👋 Welcome to ${BRAND_NAME}!`)
        .setDescription(
          `Thanks for adding **${BRAND_NAME}** to **${guild.name}**.\n\n` +
          `Open this link to set up your **web dashboard** login (pick a username + password). ` +
          `You can manage card art, server settings, and message customization from there.\n\n` +
          `🔗 ${url}\n\n` +
          `**Expires:** <t:${Math.floor(expiresAt.getTime() / 1000)}:R>\n` +
          `Need a fresh link later? Run \`/dashboard\` in your server.\n\n` +
          `Quick start: run \`/welcome\` for the public intro, then \`/setup\` to configure spawning.`,
        );
      await owner.send({ embeds: [embed] });
    } catch (err) {
      logger.warn({ err, guildId: guild.id }, "Could not DM server owner with dashboard setup link");
    }
  });

  // ── Interactions: slash commands + buttons ────────────────────────────────
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    try {
      // ── Autocomplete (card / set suggestions as user types) ───────────────
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction);
        return;
      }

      // ── AFK Secretary components/modals (afk:* customIds) ─────────────────
      // Intercept early so the AFK switchboard owns every button, select menu
      // and modal it namespaced — without touching the routers below.
      if (
        (interaction.isMessageComponent() || interaction.isModalSubmit()) &&
        interaction.customId.startsWith("afk:")
      ) {
        await handleAfkInteraction(interaction);
        return;
      }

      // ── Quiet Mode / Quiet Room (quiet:* buttons) ─────────────────────────
      if (
        interaction.isMessageComponent() &&
        interaction.customId.startsWith("quiet:")
      ) {
        await handleQuietInteraction(interaction);
        return;
      }

      // ── /emoji controls (emoji:* selects/buttons/modals) ──────────────────
      // One router owns the whole control panel: style browser, secondary
      // selects, format buttons, Done, and the style-search modal.
      if (
        (interaction.isMessageComponent() || interaction.isModalSubmit()) &&
        interaction.customId.startsWith("emoji:")
      ) {
        const { handleEmojiInteraction } = await import("./emoji/commands/emoji.js");
        await handleEmojiInteraction(interaction);
        return;
      }

      // ── /quote builder (quote:* selects/buttons/modals) ────────────────────
      if (
        (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu()
          || interaction.isModalSubmit()) &&
        interaction.customId.startsWith("quote:")
      ) {
        const { handleQuoteInteraction } = await import("./quote/command.js");
        await handleQuoteInteraction(interaction);
        return;
      }

      // ── Tamagotchi pets addon (pet:* buttons/selects/modals) ────────────────
      if (
        (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) &&
        interaction.customId.startsWith("pet:")
      ) {
        const { handlePetComponent } = await import("./pets/command.js");
        await handlePetComponent(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("pet:")) {
        const { handlePetModal } = await import("./pets/command.js");
        await handlePetModal(interaction);
        return;
      }

      // ── UnbelievaBoat Discord dashboard (ubadmin:* components) ─────────────
      if (
        (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu()
          || interaction.isRoleSelectMenu() || interaction.isChannelSelectMenu()) &&
        interaction.customId.startsWith("ubadmin:")
      ) {
        const { handleUbAdminComponent } = await import("./unbelievaboat/discord-admin.js");
        await handleUbAdminComponent(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("ubadmin:")) {
        const { handleUbAdminModal } = await import("./unbelievaboat/discord-admin.js");
        await handleUbAdminModal(interaction);
        return;
      }
      // ── Panel hubs: trade / vaultvalue / cardadmin / secret / casino ────────
      if (
        (interaction.isButton() || interaction.isUserSelectMenu()) &&
        interaction.customId.startsWith("tradehub:")
      ) {
        const { handleTradeHubComponent } = await import("./commands/trade-hub.js");
        await handleTradeHubComponent(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("tradehub:")) {
        const { handleTradeHubModal } = await import("./commands/trade-hub.js");
        await handleTradeHubModal(interaction);
        return;
      }
      if (
        (interaction.isButton() || interaction.isChannelSelectMenu() || interaction.isStringSelectMenu()) &&
        interaction.customId.startsWith("vvhub:")
      ) {
        const { handleVaultValueHubComponent } = await import("./commands/vaultvalue-hub.js");
        await handleVaultValueHubComponent(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("vvhub:")) {
        const { handleVaultValueHubModal } = await import("./commands/vaultvalue-hub.js");
        await handleVaultValueHubModal(interaction);
        return;
      }
      if (
        (interaction.isButton() || interaction.isUserSelectMenu()) &&
        interaction.customId.startsWith("cahub:")
      ) {
        const { handleCardAdminHubComponent } = await import("./commands/cardadmin-hub.js");
        await handleCardAdminHubComponent(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("cahub:")) {
        const { handleCardAdminHubModal } = await import("./commands/cardadmin-hub.js");
        await handleCardAdminHubModal(interaction);
        return;
      }
      if (
        (interaction.isButton() || interaction.isUserSelectMenu()) &&
        interaction.customId.startsWith("secrethub:")
      ) {
        const { handleSecretHubComponent } = await import("./commands/secret-hub.js");
        await handleSecretHubComponent(interaction);
        return;
      }
      if (
        (interaction.isButton() || interaction.isUserSelectMenu() || interaction.isStringSelectMenu()) &&
        interaction.customId.startsWith("casinohub:")
      ) {
        const { handleCasinoHubComponent } = await import("./unbelievaboat/casino.js");
        await handleCasinoHubComponent(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("casinohub:")) {
        const { handleCasinoHubModal } = await import("./unbelievaboat/casino.js");
        await handleCasinoHubModal(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("unbgame:slots:")) {
        const { handleSlotsModal } = await import("./unbelievaboat/live-slots.js");
        if (await handleSlotsModal(interaction)) return;
      }
      // ── Tatsu Discord dashboard (tatsu:* components) ───────────────────────
      if (
        (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu()
          || interaction.isChannelSelectMenu()) &&
        interaction.customId.startsWith("tatsu:")
      ) {
        const { handleTatsuAdminComponent } = await import("./tatsu/discord-admin.js");
        await handleTatsuAdminComponent(interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("tatsu:")) {
        const { handleTatsuAdminModal } = await import("./tatsu/discord-admin.js");
        await handleTatsuAdminModal(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith("unbgame:")) {
        const { handleUnbGameComponent } = await import("./unbelievaboat/games.js");
        await handleUnbGameComponent(interaction);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("unbstore:")) {
        const { handleCashStoreSelect } = await import("./unbelievaboat/store.js");
        await handleCashStoreSelect(interaction);
        return;
      }

      // ── Wild Mini-Game gameplay buttons (mg:* customIds) ───────────────────
      // Routed early so the encounter owns its own buttons. `mg:` is distinct
      // from the `minigames:` admin panel prefix below.
      if (interaction.isButton() && interaction.customId.startsWith("mg:")) {
        const { handleMiniGameInteraction } = await import("./minigame/manager.js");
        await handleMiniGameInteraction(interaction);
        return;
      }

      // ── Wild Mini-Games admin panel (minigames:* buttons/selects/modals) ───
      if (
        (interaction.isMessageComponent() || interaction.isModalSubmit()) &&
        interaction.customId.startsWith("minigames:")
      ) {
        const { handleMiniGamesInteraction } = await import("./commands/minigames-panel.js");
        await handleMiniGamesInteraction(interaction);
        return;
      }

      // ── String select menus (config panel + setup panel) ──────────────────
      if (interaction.isStringSelectMenu()) {
        if (interaction.customId.startsWith("help:")) {
          await handleHelpHubComponent(interaction);
        } else if (interaction.customId.startsWith("user-hub:")) {
          const { handleUserHubComponent } = await import("./commands/user-hub.js");
          await handleUserHubComponent(interaction);
        } else if (interaction.customId.startsWith("embed:")) {
          const { handleEmbedDesignerComponent } = await import("./commands/embed-designer.js");
          await handleEmbedDesignerComponent(interaction);
        } else if (interaction.customId.startsWith("market-hub:")) {
          const { handleMarketHubComponent } = await import("./commands/market-hub.js");
          await handleMarketHubComponent(interaction);
        } else if (interaction.customId.startsWith("gwhub:")) {
          await handleGiveawayHubComponent(interaction);
        } else if (interaction.customId.startsWith("squad-hub:")) {
          const { handleSquadHubComponent } = await import("./commands/squad-hub.js");
          await handleSquadHubComponent(interaction);
        } else if (interaction.customId.startsWith("battle:")) {
          await handleBattleComponent(interaction);
        } else if (interaction.customId.startsWith("raid:")) {
          await handleRaidComponent(interaction);
        } else if (interaction.customId.startsWith("battleadmin:")) {
          await handleBattleAdminSelect(interaction);
        } else if (interaction.customId.startsWith("cfgexp:") || interaction.customId.startsWith("cfgexpfb:")) {
          await handleExperienceSelect(interaction);
        } else if (interaction.customId.startsWith("config_")) {
          await handleConfigSelect(interaction);
        } else if (interaction.customId.startsWith("rates_")) {
          await handleRatesSelect(interaction);
        } else if (interaction.customId.startsWith("packs_")) {
          await handlePacksSelect(interaction);
        } else if (interaction.customId.startsWith("setup_")) {
          await handleSetupSelect(interaction);
        } else if (interaction.customId === "setchannels:pick") {
          await handleSetChannelsPick(interaction);
        } else if (interaction.customId === "sets:pick") {
          await handleSetsHubSelect(interaction);
        } else if (interaction.customId === "setadminhub:select") {
          await handleSetAdminHubSelect(interaction);
        } else if (interaction.customId.startsWith("setadminhub:weight:")) {
          await handleSetAdminHubWeightSelect(interaction);
        } else if (interaction.customId.startsWith("editcard:")) {
          await handleEditCardSelect(interaction);
        } else if (interaction.customId === "rarity_edit:select") {
          await handleRarityEditSelect(interaction);
        } else if (interaction.customId.startsWith("rarity_hub:settings:select") || interaction.customId.startsWith("rarity_hub:economy:select") || interaction.customId.startsWith("rarity_hub:custom:select:")) {
          await handleRarityHubSelect(interaction);
        } else if (interaction.customId.startsWith("edituser:")) {
          const { handleEditUserInteraction } = await import("./commands/edit-user.js");
          await handleEditUserInteraction(interaction);
        } else if (interaction.customId.startsWith("recycle:")) {
          const { handleFusionComponent } = await import("./cards/fusion.js");
          await handleFusionComponent(interaction);
        } else if (interaction.customId === "top:cat") {
          const { handleTopSelect } = await import("./commands/leaderboard.js");
          await handleTopSelect(interaction);
        } else if (interaction.customId.startsWith("show-shiny:")) {
          const { handleShowShinyComponent } = await import("./commands/show-shiny.js");
          await handleShowShinyComponent(interaction);
        } else if (interaction.customId.startsWith("collhub:")) {
          const { handleCollectionHubComponent } = await import("./commands/collection-hub.js");
          await handleCollectionHubComponent(interaction);
        } else if (interaction.customId.startsWith("hq-hub:")) {
          const { handleHqHubComponent } = await import("./commands/hq-hub.js");
          await handleHqHubComponent(interaction);
        } else if (interaction.customId.startsWith("hqadmin:")) {
          const { handleHqAdminComponent } = await import("./commands/hq-admin.js");
          await handleHqAdminComponent(interaction);
        } else if (interaction.customId.startsWith("mtcalc:")) {
          await handleMTTVCalcSelect(interaction);
        } else if (interaction.customId.startsWith("mttcalc_hub:")) {
          await handleMttvHubSelect(interaction);
        }
        return;
      }

      // ── Channel select menus (/setchannels step 2) ─────────────────────────
      if (interaction.isChannelSelectMenu()) {
        if (interaction.customId.startsWith("setchannels:set:")) {
          await handleSetChannelsApply(interaction);
        } else if (interaction.customId.startsWith("battleadmin:")) {
          await handleBattleAdminChannelSelect(interaction);
        }
        return;
      }

      // ── User select menus (user-hub rep) ───────────────────────────────────
      if (interaction.isUserSelectMenu()) {
        if (interaction.customId.startsWith("user-hub:")) {
          const { handleUserHubComponent } = await import("./commands/user-hub.js");
          await handleUserHubComponent(interaction);
        }
        return;
      }

      // ── Modal submissions (admin hub + setup test card + custom mix) ─────
      if (interaction.isModalSubmit()) {
        if (isSecretModal(interaction.customId)) {
          await handleSecretModal(interaction);
        } else if (interaction.customId.startsWith("battleadmin:")) {
          await handleBattleAdminModal(interaction);
        } else if (interaction.customId.startsWith("adminhub:")) {
          await handleAdminHubModal(interaction);
        } else if (interaction.customId.startsWith("mttcalc_hub_modal:")) {
          await handleMttvHubModal(interaction);
        } else if (interaction.customId.startsWith("mtcalc_modal:")) {
          await handleMTTVCalcModal(interaction);
        } else if (interaction.customId.startsWith("setup_")) {
          await handleSetupModalSubmit(interaction);
        } else if (interaction.customId === "rates_custom") {
          await handleRatesCustomModal(interaction);
        } else if (interaction.customId.startsWith("sets:modal:")) {
          await handleSetsHubModal(interaction);
        } else if (interaction.customId.startsWith("setadminhub:modal:")) {
          await handleSetAdminHubModal(interaction);
        } else if (interaction.customId.startsWith("editcard:modal:")) {
          await handleEditCardModal(interaction);
        } else if (interaction.customId.startsWith("editimage:search_modal:")) {
          await handleEditImageModal(interaction);
        } else if (interaction.customId.startsWith("rarity_edit:modal:")) {
          await handleRarityEditModal(interaction);
        } else if (interaction.customId.startsWith("rarity_hub:modal:")) {
          await handleRarityHubModal(interaction);
        } else if (interaction.customId.startsWith("edituser:modal:")) {
          const { handleEditUserModal } = await import("./commands/edit-user.js");
          await handleEditUserModal(interaction);
        } else if (interaction.customId.startsWith("embed:")) {
          const { handleEmbedDesignerModal } = await import("./commands/embed-designer.js");
          await handleEmbedDesignerModal(interaction);
        } else if (interaction.customId.startsWith("market-hub:modal:")) {
          const { handleMarketHubModal } = await import("./commands/market-hub.js");
          await handleMarketHubModal(interaction);
        } else if (interaction.customId.startsWith("squad-hub:modal:")) {
          const { handleSquadHubModal } = await import("./commands/squad-hub.js");
          await handleSquadHubModal(interaction);
        } else if (interaction.customId.startsWith("user-hub:modal:")) {
          const { handleUserHubModal } = await import("./commands/user-hub.js");
          await handleUserHubModal(interaction);
        } else if (interaction.customId.startsWith("hq-hub:modal:")) {
          const { handleHqHubModal } = await import("./commands/hq-hub.js");
          await handleHqHubModal(interaction);
        } else if (interaction.customId.startsWith("hqadmin:")) {
          const { handleHqAdminModal } = await import("./commands/hq-admin.js");
          await handleHqAdminModal(interaction);
        } else if (interaction.customId === "recycle:search") {
          const { handleFusionSearchModal } = await import("./cards/fusion.js");
          await handleFusionSearchModal(interaction);
        } else if (interaction.customId.startsWith("recycle:spendxp:")) {
          const { handleFusionSpendScrapModal } = await import("./cards/fusion.js");
          await handleFusionSpendScrapModal(interaction);
        } else if (interaction.customId.startsWith("battle:psearch:")) {
          const { handleBattlePrepSearchModal } = await import("./battle/battle-manager.js");
          await handleBattlePrepSearchModal(interaction);
        } else if (interaction.customId === "config:recycle:values") {
          const { handleRecycleValuesModal } = await import("./commands/config-panel.js");
          await handleRecycleValuesModal(interaction);
        } else if (interaction.customId.startsWith("config:custom:")) {
          const { handleConfigCustomModal } = await import("./commands/config-panel.js");
          await handleConfigCustomModal(interaction);
        } else if (interaction.customId.startsWith("config:boost:")) {
          const { handleConfigBoostModal } = await import("./commands/config-panel.js");
          await handleConfigBoostModal(interaction);
        } else if (interaction.customId === "config:shiny:name") {
          const { handleShinyNameModal } = await import("./commands/config-panel.js");
          await handleShinyNameModal(interaction);
        } else if (interaction.customId.startsWith("gwhub:")) {
          await handleGiveawayHubComponent(interaction);
        } else if (interaction.customId.startsWith("collhub:")) {
          const { handleCollectionHubModal } = await import("./commands/collection-hub.js");
          await handleCollectionHubModal(interaction);
        }
        return;
      }

      // ── Button interactions ────────────────────────────────────────────────
      if (interaction.isButton()) {
        const parts = interaction.customId.split(":");
        const action = parts[0];

        // ── Echo-Whisper reveal buttons ────────────────────────────────────
        if (isSecretButton(interaction.customId)) {
          await handleSecretButton(interaction);
          return;
        }

        // ── Native Activity launch (text-channel LAUNCH_ACTIVITY) ──────────
        if (action === LAUNCH_PREFIX) {
          await handleExperienceLaunch(interaction);
          return;
        }

        // ── Battle system buttons (challenge, prep, combat moves) ──────────
        if (action === "battle") {
          await handleBattleComponent(interaction);
          return;
        }

        // ── Edit-user panel view switch (💳 Core / ⚔️ Battle) ──────────────
        if (action === "edituser") {
          const { handleEditUserButton } = await import("./commands/edit-user.js");
          await handleEditUserButton(interaction);
          return;
        }

        // ── User-hub buttons (daily claim, open sub-hubs, etc.) ────────────
        if (action === "user-hub") {
          const { handleUserHubComponent } = await import("./commands/user-hub.js");
          await handleUserHubComponent(interaction);
          return;
        }

        // ── Show Shiny picker buttons (Show Best) ──────────────────────────
        if (action === "show-shiny") {
          const { handleShowShinyComponent } = await import("./commands/show-shiny.js");
          await handleShowShinyComponent(interaction);
          return;
        }

        // ── Collection hub (paging, filters, search, card detail) ──────────
        if (action === "collhub") {
          const { handleCollectionHubComponent } = await import("./commands/collection-hub.js");
          await handleCollectionHubComponent(interaction);
          return;
        }

        // ── Headquarters hub (pin cards, place decorations, theme/room) ────
        if (action === "hq-hub") {
          const { handleHqHubComponent } = await import("./commands/hq-hub.js");
          await handleHqHubComponent(interaction);
          return;
        }

        // ── HQ admin panel (server siege settings + per-member HQ editor) ──
        // Its string-selects and modals were already routed above; without this
        // branch every BUTTON on the panel silently did nothing.
        if (action === "hqadmin") {
          const { handleHqAdminComponent } = await import("./commands/hq-admin.js");
          await handleHqAdminComponent(interaction);
          return;
        }

        // ── Onboarding adventure buttons (continue, claim rewards) ─────────
        if (action === "onboarding") {
          const { handleOnboardingComponent } = await import("./onboarding/command.js");
          await handleOnboardingComponent(interaction);
          return;
        }

        // ── Pack privacy prompt (Open Publicly / Open Privately) ───────────
        if (action === "pack") {
          const { handlePackOpenButton } = await import("./commands/pack.js");
          await handlePackOpenButton(interaction);
          return;
        }

        // ── Card Recycle confirm button ───────────────────────────────────
        if (action === "recycle") {
          const { handleRecycleButton } = await import("./commands/tradein.js");
          await handleRecycleButton(interaction);
          return;
        }

        // ── Market / Squad hub buttons (back, confirms, pick-driven) ───────
        if (action === "market-hub") {
          const { handleMarketHubComponent } = await import("./commands/market-hub.js");
          await handleMarketHubComponent(interaction);
          return;
        }
        if (action === "squad-hub") {
          const { handleSquadHubComponent } = await import("./commands/squad-hub.js");
          await handleSquadHubComponent(interaction);
          return;
        }

        // ── Embed designer buttons (visual embed customizer) ─────────────
        if (action === "embed") {
          const { handleEmbedDesignerComponent } = await import("./commands/embed-designer.js");
          await handleEmbedDesignerComponent(interaction);
          return;
        }

        // ── Raid buttons (lobby join/begin, combat actions) ────────────────
        if (action === "raid") {
          await handleRaidComponent(interaction);
          return;
        }

        // ── Giveaway buttons (my progress, details, claim prize) ───────────
        if (action === "giveaway") {
          await handleGiveawayComponent(interaction);
          return;
        }

        // ── Giveaway hub buttons (browse, admin quick-create, manage) ──────
        if (action === "gwhub") {
          await handleGiveawayHubComponent(interaction);
          return;
        }

        // ── Help hub nav buttons (home) ────────────────────────────────────
        if (action === "help") {
          await handleHelpHubComponent(interaction);
          return;
        }

        // ── Battle-stats quick view (from /info) — read-only, no combat ────
        if (action === "battlestats") {
          if (!interaction.guild) return;
          const guildId = interaction.guild.id;
          const cardId = parseInt(parts[1], 10);
          const cards = await getAllCardsCached(guildId);
          const card = cards.find(c => c.id === cardId);
          if (!card) {
            await interaction.reply({ content: "❌ This card no longer exists.", flags: MessageFlags.Ephemeral });
            return;
          }
          const ctx = await getRarityContext(guildId);
          const [effCard] = applyRarityContextAll([card], ctx);
          const embed = await buildBattleStatsEmbed(
            guildId, interaction.user.id, card,
            effectiveRarityKey(effCard!, ctx) as import("./cards-data.js").Rarity,
          );
          // Feature the same reveal canvas players see after a catch — now WITH
          // the Level-1 stat block (and the viewer's ⭐ Star Rank baked in).
          const { renderCardRevealCanvas, CARD_REVEAL_FILE } = await import("./cards/card-reveal-canvas.js");
          const reveal = await renderCardRevealCanvas(guildId, cardId, { withStats: true, userId: interaction.user.id });
          if (reveal) embed.setImage(`attachment://${CARD_REVEAL_FILE}`);
          await interaction.reply({
            embeds: [embed],
            components: [battleStatsLevelJumpRow(cardId)],
            files: reveal ? [reveal.file] : [],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // ── View Animation (from /info) — show the live animated GIF ───────
        // The /info hero is a rendered canvas (a still frame), which flattens a
        // GIF card. This surfaces the raw animated art so Discord loops it.
        if (action === "cardgif") {
          if (!interaction.guild) return;
          const guildId = interaction.guild.id;
          const cardId = parseInt(parts[1], 10);
          const cards = await getAllCardsCached(guildId);
          const card = cards.find(c => c.id === cardId);
          const gif = card ? toAbsoluteImageUrl(card.imageUrl) : null;
          if (!card || !gif) {
            await interaction.reply({ content: "❌ No animation available for this card.", flags: MessageFlags.Ephemeral });
            return;
          }
          const embed = new EmbedBuilder()
            .setTitle(`🎬 ${card.name}`)
            .setColor(rarityColor(card.rarity as import("./cards-data.js").Rarity))
            .setImage(gif);
          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          return;
        }

        // ── Quick-jump from battle-stats view → same embed as /level ───────
        if (action === "battlestats_level") {
          if (!interaction.guild) return;
          const guildId = interaction.guild.id;
          const cardId = parseInt(parts[1], 10);
          const cards = await getAllCardsCached(guildId);
          const card = cards.find(c => c.id === cardId);
          if (!card) {
            await interaction.reply({ content: "❌ This card no longer exists.", flags: MessageFlags.Ephemeral });
            return;
          }
          const result = await buildCardLevelEmbed(guildId, interaction.user.id, card);
          await interaction.reply({
            content: "error" in result ? result.error : undefined,
            embeds: "embed" in result ? [result.embed] : [],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // ── Battle admin hub buttons ───────────────────────────────────────
        if (action === "battleadmin") {
          await handleBattleAdminButton(interaction);
          return;
        }

        // ── Config panel buttons (toggle, channel set) ─────────────────────
        if (action === "config") {
          await handleConfigButton(interaction);
          return;
        }

        // ── Setup wizard panel buttons ─────────────────────────────────────
        if (action === "setup") {
          await handleSetupButton(interaction);
          return;
        }

        // ── Admin hub buttons ─────────────────────────────────────────────
        if (action === "adminhub") {
          await handleAdminHubButton(interaction);
          return;
        }
        if (action === "mttcalc_hub") {
          await handleMttvHubButton(interaction);
          return;
        }
        if (action === "mtcalc") {
          await handleMTTVCalcButton(interaction);
          return;
        }
        // ── Sets hub panel buttons ─────────────────────────────────────────
        if (action === "sets") {
          await handleSetsHubButton(interaction);
          return;
        }

        // ── Set admin hub buttons ──────────────────────────────────────────
        if (action === "setadminhub") {
          await handleSetAdminHubButton(interaction);
          return;
        }

        // ── Rarity hub + display edit panel buttons ────────────────────────
        if (action === "rarity_hub") {
          await handleRarityHubButton(interaction);
          return;
        }

        if (action === "rarity_edit") {
          await handleRarityEditButton(interaction);
          return;
        }

        if (action === "editimage") {
          if (interaction.customId.startsWith("editimage:pick:") || interaction.customId.startsWith("editimage:cancel:")) {
            await handleEditImagePick(interaction);
          } else {
            await handleEditImageButton(interaction);
          }
          return;
        }

        // ── Spawn Claim button (button/both catch mode) ────────────────────
        if (action === "spawn_claim") {
          const [, guildId, spawnId] = parts;
          // Ack IMMEDIATELY (before any DB call). Discord gives us a 3s window
          // to respond; under spawn fan-out load the catchCard + markCaught
          // round-trip can edge past that, leaving the user with a silent
          // "interaction failed" and the need to click twice. deferUpdate
          // here parks the interaction so we can take as long as we need.
          await interaction.deferUpdate().catch(() => { /* ignore */ });
          const result = await handleClaimButtonClick(guildId, spawnId, interaction.user.id, {
            // Button catches have an interaction → the catcher gets a private
            // ephemeral canvas preview; the public confirmation stays as-is.
            sendEphemeral: (payload) =>
              interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }).then(() => { /* void */ }),
          });
          if (!result.ok) {
            // self_already / expired = the winner is double-tapping their own
            // claim. Silently ack — the spawn embed above already shows the
            // Burn/Keep/Trade buttons, no need for a redundant "scroll up" nag.
            if (result.reason === "self_already" || result.reason === "expired") {
              return;
            }
            const reasonMsg =
              result.reason === "already_caught" ? "⚡ Too slow! Someone already claimed this card."
              : result.reason === "timed_out" ? `⏱️ You're timed out from catching cards until <t:${Math.floor(result.timedOutUntil!.getTime() / 1000)}:f>.`
              : "❌ This button isn't active right now.";
            await interaction.followUp({ content: reasonMsg, flags: MessageFlags.Ephemeral }).catch(() => { /* ignore */ });
          } else {
            // Successful claim — already acked above. The spawn embed updates
            // to "CLAIMED" with the Burn/Keep/Trade row in the same message,
            // so a separate ephemeral confirmation is just noise.
            const unlocked = await checkAchievements(guildId, interaction.user.id).catch(() => []);
            if (unlocked.length > 0) {
              await interaction.followUp({
                content: "🏆 **Achievement unlocked!**\n" + unlocked.map(formatUnlockLine).join("\n"),
                flags: MessageFlags.Ephemeral,
              }).catch(() => { /* ignore */ });
            }
          }
          return;
        }

        // Spacer buttons are disabled, but Discord may still send a click if
        // the client gets out of sync — silently ack.
        if (action === "spawn_spacer") {
          await interaction.deferUpdate().catch(() => { /* ignore */ });
          return;
        }

        // ── Trade Accept/Decline buttons ───────────────────────────────────
        if (action === "trade_accept" || action === "trade_decline") {
          const tradeId = parseInt(parts[1], 10);
          await handleTradeButton(interaction, action === "trade_accept" ? "accept" : "decline", tradeId);
          return;
        }

        if (action === "catch_burn" || action === "catch_keep" || action === "catch_trade") {
          const [, guildId, userId, cardIdStr, shinyFlag] = parts;
          const cardId = parseInt(cardIdStr, 10);
          // 5th segment present only on burn buttons minted after the shiny
          // rollout; pre-rollout buttons fall back to non-shiny (correct since
          // those pre-existed the feature).
          const isShinyCatch = shinyFlag === "1";

          if (interaction.user.id !== userId) {
            await interaction.reply({
              content: "❌ These buttons are only for the player who caught this card.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          // Look up the card name for any public announcement.
          const allCards = await getAllCards(guildId);
          const card = allCards.find(c => c.id === cardId);
          const cardName = card?.name ?? "the card";
          const burnValue = card?.burnValue ?? 0;

          // Mark decision FIRST so the 90s auto-keep timer can't race ahead
          // and overwrite this embed while we're still computing the reply.
          markDecisionMade(guildId, userId, cardId);

          // Lock the buttons IMMEDIATELY by replacing the row with its disabled
          // sibling before doing any DB work. This single update() both acks the
          // interaction (avoiding the 3s timeout under load) and rules out the
          // double-click race that previously let a fast second tap fire Burn
          // twice — the second click would then hit the "may have already been
          // burned" path even though the user only meant to click once.
          const chosen = action === "catch_burn" ? "burn"
            : action === "catch_keep" ? "keep" : "trade";
          await interaction.update({
            components: [buildDisabledDecisionRow(guildId, userId, cardId, burnValue, chosen)],
          }).catch(() => { /* may be deleted */ });

          if (action === "catch_burn") {
            const result = await burnCard(guildId, userId, cardId, 1, { shiny: isShinyCatch });
            if (!result.success) {
              await interaction.followUp({
                content: "❌ Couldn't burn the card — it may have already been burned.",
                flags: MessageFlags.Ephemeral,
              }).catch(() => { /* ignore */ });
              return;
            }
            const currency = await getOrCreateCurrency(guildId, userId);
            // Update the spawn embed to show the burn state in-channel. The
            // disabled row is already in place from the update() above.
            const burnedEmbed = await buildPostDecisionEmbed(cardId, userId, "burned", guildId);
            if (burnedEmbed) {
              await interaction.message.edit({
                embeds: [burnedEmbed],
                components: [buildDisabledDecisionRow(guildId, userId, cardId, burnValue, "burn")],
              }).catch(() => { /* may be deleted */ });
            }
            // Private confirmation with full shard balance
            await interaction.followUp({
              content:
                `🔥 Card burned! You received 💠 **${result.shardsGained.toLocaleString()} shards**.\n` +
                `New balance: **${currency.shards.toLocaleString()}** 💠 — check \`/shards\` anytime.`,
              flags: MessageFlags.Ephemeral,
            }).catch(() => { /* ignore */ });
            try {
              const { recordQuestEvent } = await import("./quests/engine.js");
              await recordQuestEvent(guildId, userId, "burn", 1);
              const { recordGiveawayEvent } = await import("./giveaway/engine.js");
              await recordGiveawayEvent(guildId, userId, "burn", 1);
            } catch { /* non-fatal */ }
            const burnUnlocks = await checkAchievements(guildId, userId).catch(() => []);
            if (burnUnlocks.length > 0) {
              await interaction.followUp({
                content: "🏆 **Achievement unlocked!**\n" + burnUnlocks.map(formatUnlockLine).join("\n"),
                flags: MessageFlags.Ephemeral,
              }).catch(() => { /* ignore */ });
            }
          } else if (action === "catch_keep") {
            const keptEmbed = await buildPostDecisionEmbed(cardId, userId, "kept", guildId);
            if (keptEmbed) {
              await interaction.message.edit({
                embeds: [keptEmbed],
                components: [buildDisabledDecisionRow(guildId, userId, cardId, burnValue, "keep")],
              }).catch(() => { /* may be deleted */ });
            }
            await interaction.followUp({
              content: "💾 Kept! The card is in your collection — use `/collection-hub` or **/user-hub → Collection** to view it.",
              flags: MessageFlags.Ephemeral,
            }).catch(() => { /* ignore */ });
          } else {
            // catch_trade — card stays in collection; advertise it publicly
            const tradeEmbed = await buildPostDecisionEmbed(cardId, userId, "trade", guildId);
            if (tradeEmbed) {
              await interaction.message.edit({
                embeds: [tradeEmbed],
                components: [buildDisabledDecisionRow(guildId, userId, cardId, burnValue, "trade")],
              }).catch(() => { /* may be deleted */ });
            }
            await interaction.followUp({
              content: `🔄 You're now open to trading **${cardName}**! Others can use \`/trade propose\` to make an offer.`,
              flags: MessageFlags.Ephemeral,
            }).catch(() => { /* ignore */ });
          }
        }
        return;
      }

      // ── Slash commands ─────────────────────────────────────────────────────
      // ── Message context menus (Apps → Make it a Quote) ────────────────────
      if (interaction.isMessageContextMenuCommand()) {
        if (interaction.commandName === "Make it a Quote") {
          const { handleQuoteContextMenu } = await import("./quote/command.js");
          await handleQuoteContextMenu(interaction);
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;
      // Translate the clean, registered command name (e.g. "battle_admin") back
      // to its internal handler name (e.g. "battleadmin") so every branch and
      // dispatch set below keeps working unchanged.
      const cmd = internalCommandName(interaction.commandName);

      if (cmd === "battle") {
        await handleBattleCommand(interaction, interaction.options.getSubcommand(true));
      } else if (cmd === "battleadmin") {
        await handleBattleAdminCommand(interaction);
      } else if (cmd === "market") {
        await handleMarketCommand(interaction);
      } else if (cmd === "squad") {
        await handleSquadCommand(interaction);
      } else if (cmd === "raid") {
        await handleRaidCommand(interaction);
      } else if (cmd === "raidadmin") {
        await handleRaidAdminCommand(interaction);
      } else if (cmd === "giveaway") {
        await handleGiveawayHubCommand(interaction);
      } else if (cmd === "whisper") {
        await handleWhisperCommand(interaction);
      } else if (cmd === "adminsecret") {
        await handleAdminSecretCommand(interaction);
      } else if (cmd === "secret") {
        const { handleSecretCommand } = await import("./commands/secret-hub.js");
        await handleSecretCommand(interaction);
      } else if (cmd === "echo") {
        await handleEchoCommand(interaction);
      } else if (cmd === "emoji") {
        const { handleEmojiCommand } = await import("./emoji/commands/emoji.js");
        await handleEmojiCommand(interaction);
      } else if (cmd === "afk") {
        await handleAfkCommand(interaction);
      } else if (cmd === "afksetup") {
        await handleAfkSetupCommand(interaction);
      } else if (cmd === "quiet") {
        await handleQuietCommand(interaction);
      } else if (cmd === "vacation") {
        await handleVacationCommand(interaction);
      } else if (cmd === "loa") {
        await handleLoaCommand(interaction);
      } else if (cmd === "quietsetup") {
        await handleQuietSetupCommand(interaction);
      } else if (cmd === "begin") {
        const { handleOnboardingCommand } = await import("./onboarding/command.js");
        await handleOnboardingCommand(interaction);
      } else if (cmd === "show_shiny") {
        const { handleShowShinyCommand } = await import("./commands/show-shiny.js");
        await handleShowShinyCommand(interaction);
      } else if (cmd === "quote") {
        const { handleQuoteCommand } = await import("./quote/command.js");
        await handleQuoteCommand(interaction);
      } else if (cmd === "collection_hub") {
        const { handleCollectionHubCommand } = await import("./commands/collection-hub.js");
        await handleCollectionHubCommand(interaction);
      } else if (cmd === "hq") {
        const { handleHqCommand } = await import("./commands/hq-hub.js");
        await handleHqCommand(interaction);
      } else if (cmd === "hqadmin") {
        const { handleHqAdminCommand } = await import("./commands/hq-admin.js");
        await handleHqAdminCommand(interaction);
      } else if (cmd === "hqbuild") {
        const { handleHqBuildCommand } = await import("./commands/hq-build.js");
        await handleHqBuildCommand(interaction);
      } else if (cmd === "pet") {
        const { handlePetCommand } = await import("./pets/command.js");
        await handlePetCommand(interaction);
      } else if (cmd === "petadmin") {
        const { handlePetAdminCommand } = await import("./pets/command.js");
        await handlePetAdminCommand(interaction);
      } else if (cmd === "ubadmin" || cmd === "unbelievaboat") {
        const { handleUbAdminCommand } = await import("./unbelievaboat/discord-admin.js");
        await handleUbAdminCommand(interaction);
      } else if (cmd === "tatsu") {
        const { handleTatsuAdminCommand } = await import("./tatsu/discord-admin.js");
        await handleTatsuAdminCommand(interaction);
      } else if (cmd === "casino") {
        const { handleCasinoCommand } = await import("./unbelievaboat/casino.js");
        await handleCasinoCommand(interaction);
      } else if (cmd.endsWith("_ub")) {
        const { handleUbSlashCommand } = await import("./unbelievaboat/ub-slash-router.js");
        await handleUbSlashCommand(interaction, cmd);
      } else if (cmd === "vaultvalue") {
        const { handleVaultValueCommand } = await import("./commands/vaultvalue-hub.js");
        await handleVaultValueCommand(interaction);
      } else if (cmd === "cardadmin") {
        const { handleCardAdminCommand } = await import("./commands/cardadmin-hub.js");
        await handleCardAdminCommand(interaction);
      } else if (cmd === "trade") {
        const { handleTradeHubCommand } = await import("./commands/trade-hub.js");
        await handleTradeHubCommand(interaction);
      } else if (USER_HUB_COMMANDS.has(cmd)) {
        // Flattened player commands (/burn, /pack, …) + hub-backed handlers
        // (daily/collection/… via /user-hub) and other player routes.
        await handleUserCommand(interaction, cmd);
      } else if (ADMIN_HUB_COMMANDS.has(cmd)) {
        // Flattened admin commands (/drop, /give, /setup, …) + set hubs
        // (/set_hub, /set_admin), /event, etc.
        await handleAdminCommand(interaction, cmd);
      }
    } catch (err) {
      logger.error({ err }, "Interaction error");
      try {
        const msg = "❌ Something went wrong. Please try again.";
        if ("deferred" in interaction && interaction.deferred) {
          await (interaction as any).editReply(msg);
        } else if ("replied" in interaction && !(interaction as any).replied) {
          await (interaction as any).reply({ content: msg, flags: MessageFlags.Ephemeral });
        }
      } catch { /* ignore */ }
    }
  });

  // ── Command dispatch coverage guard ───────────────────────────────────────
  // Fail fast at startup if any registered slash command has no handler route.
  const routedInternalNames = new Set([
    ...USER_HUB_COMMANDS,
    ...ADMIN_HUB_COMMANDS,
    // Explicitly routed in the interaction handler above.
    "battle", "battleadmin", "market", "squad", "raid", "raidadmin",
    "giveaway",
    "whisper", "adminsecret", "echo", "afk", "afksetup",
    "quiet", "vacation", "loa", "quietsetup",
    "begin", "show_shiny",
    "quote",
    "collection_hub", "hq", "hqadmin", "hqbuild",
    "pet", "petadmin", "ubadmin", "unbelievaboat", "tatsu",
    "casino", "vaultvalue", "cardadmin", "secret",
    "daily_ub", "collect_ub", "bal_ub", "deposit_ub", "withdraw_ub",
    "slots_ub", "blackjack_ub", "roulette_ub", "uno_ub", "higherlower_ub", "redblack_ub",
    "work_ub", "crime_ub", "beg_ub", "rob_ub", "russian_ub", "store_ub", "top_ub",
    "valuehelp", "valuelist", "info_mttv", "giveall", "editpack", "postcalculator",
    "postboard", "massrole", "emoji",
  ]);
  // Context menus (type 2/3) are routed separately — only chat-input names must
  // appear in routedInternalNames. ApplicationCommandType.ChatInput === 1.
  const unmapped = buildCommands()
    .filter(c => (c.type ?? 1) === 1)
    .map(c => internalCommandName(c.name))
    .filter(name => !routedInternalNames.has(name));
  if (unmapped.length > 0) {
    logger.error({ unmapped }, "Registered slash commands have no dispatch route");
    throw new Error(`Unmapped registered slash commands: ${unmapped.join(", ")}`);
  }

  // ── Messages: prefix commands → setup wizard → card wizard → catch ────────
  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.guild) return;
    const content = msg.content.trim();

    // AFK Secretary: clear the author's "on return" AFK (past grace) and post
    // the intercept embed if they pinged anyone away. Fire-and-forget — never
    // consumes the message or blocks the prefix / card-catch pipeline below.
    void handleAfkMessage(msg).catch(err => logger.debug({ err }, "AFK message hook error"));

    // Dual prefixes (per-guild): admin/card commands vs UnbelievaBoat casino games.
    const prefix = await getGuildPrefix(msg.guild.id);
    const gamesPrefix = await getGuildGamesPrefix(msg.guild.id);

    // Giveaway message-requirement tracking (anti-spam, ignores commands/bots).
    // Fire-and-forget — never consumes the message or blocks the pipeline below.
    void handleGiveawayMessage(msg, prefix).catch(err => logger.debug({ err }, "Giveaway message hook error"));

    // Prefer longer prefix when both match the same string start (e.g. `!!` vs `!`).
    const adminHit = content.startsWith(prefix);
    const gamesHit = content.startsWith(gamesPrefix);
    if (adminHit || gamesHit) {
      if (adminHit && gamesHit) {
        if (gamesPrefix.length > prefix.length) {
          const { handleUbPrefixCommand } = await import("./unbelievaboat/ub-prefix-router.js");
          const consumed = await handleUbPrefixCommand(msg, gamesPrefix).catch(err => {
            logger.error({ err }, "UB prefix command error");
            return true;
          });
          if (consumed) return;
        }
        await handlePrefixCommand(msg, prefix).catch(err => logger.error({ err }, "Prefix command error"));
        return;
      }
      if (gamesHit) {
        const { handleUbPrefixCommand } = await import("./unbelievaboat/ub-prefix-router.js");
        const consumed = await handleUbPrefixCommand(msg, gamesPrefix).catch(err => {
          logger.error({ err }, "UB prefix command error");
          return true;
        });
        if (consumed) return;
      }
      if (adminHit) {
        await handlePrefixCommand(msg, prefix).catch(err => logger.error({ err }, "Prefix command error"));
        return;
      }
    }

    // Card creation wizard step responses
    const cardConsumed = await handleCardWizardStep(msg).catch(() => false);
    if (cardConsumed) return;

    // Card edit wizard step responses
    const editConsumed = await handleCardEditStep(msg).catch(() => false);
    if (editConsumed) return;

    // Core card catch detection — pass Discord-stamped timestamp so the
    // spawn-manager can do lag-fair winner selection (earliest sent wins,
    // not earliest processed).
    const result = await handleCatchAttempt(
      msg.guild.id, msg.author.id, content, msg.createdTimestamp, msg.channelId,
    ).catch(err => {
      logger.error({ err }, "Catch attempt error");
      return { matched: false, awaiting: false, timedOutUntil: undefined as Date | undefined };
    });
    if (result.matched) {
      if (result.timedOutUntil) {
        try {
          await msg.reply({
            content: `⏱️ <@${msg.author.id}> you're timed out from catching cards until <t:${Math.floor(result.timedOutUntil.getTime() / 1000)}:f>.`,
            allowedMentions: { users: [msg.author.id] },
          });
        } catch { /* ignore */ }
        return;
      }
      try { await msg.react("🎯"); } catch { /* ignore */ }
      // Winner is decided inside spawn-manager after a short grace window;
      // achievements for the typing winner are checked there too.
    }
  });

  await client.login(token).catch(err => {
    logger.error({ err }, "Failed to login — check DISCORD_BOT_TOKEN");
  });
}

// ── Register: clear stale globals (keep Activity Entry Point), guild-only slash ─
// Discord refuses PUT [] on global commands when an Activity Entry Point exists
// (error 50240). That used to leave OLD flat globals (/gift, /accept, /drop, …)
// alive next to the new guild hubs — clients then showed both. Preserve type-4
// Entry Point only, wipe every other global, then overwrite each guild.
async function registerCommands(appId: string, token: string, client: Client) {
  const rest = new REST().setToken(token);
  const commands = buildCommands();
  const chatNames = commands
    .filter((c: { type?: number; name: string }) => (c.type ?? 1) === 1)
    .map((c: { name: string }) => c.name)
    .sort();
  const hubsPresent = ["trade", "vaultvalue", "cardadmin", "secret", "casino", "tatsu", "help"]
    .filter(n => chatNames.includes(n));
  const ubSlash = chatNames.filter(n => n.endsWith("_ub"));
  const foldedStillRegistered = [...HUB_REPLACED_COMMANDS].filter(n => chatNames.includes(n));

  logger.info({
    chatCount: chatNames.length,
    hubsPresent,
    ubSlashCount: ubSlash.length,
    ubSlash,
    foldedStillRegistered,
  }, "Slash registration payload");

  if (foldedStillRegistered.length > 0) {
    logger.error({ foldedStillRegistered }, "HUB_REPLACED names still in buildCommands — hubs filter broken");
  }

  // 1) Wipe stale GLOBAL chat commands, but keep the Activity Entry Point.
  try {
    const existing = (await rest.get(Routes.applicationCommands(appId))) as Array<{
      id?: string;
      name: string;
      type?: number;
      description?: string;
      handler?: number;
      integration_types?: number[];
      contexts?: number[] | null;
      options?: unknown[];
    }>;
    const entryPoints = existing.filter(c => c.type === ApplicationCommandType.PrimaryEntryPoint);
    const staleGlobals = existing.filter(c => c.type !== ApplicationCommandType.PrimaryEntryPoint);

    const keepBody = entryPoints.map(c => ({
      name: c.name,
      type: ApplicationCommandType.PrimaryEntryPoint,
      description: c.description || "",
      ...(c.handler != null ? { handler: c.handler } : {}),
      ...(c.integration_types ? { integration_types: c.integration_types } : {}),
      ...(c.contexts !== undefined ? { contexts: c.contexts } : {}),
    }));

    await rest.put(Routes.applicationCommands(appId), { body: keepBody });
    logger.info({
      clearedGlobals: staleGlobals.map(c => c.name),
      keptEntryPoints: entryPoints.map(c => c.name),
    }, "Global slash commands cleared (Entry Point preserved)");
  } catch (err) {
    logger.error({ err }, "Failed to clear global commands — old flat globals may still appear in Discord");
  }

  // 2) Register guild-specific only — instant effect, no 1-hour propagation.
  // Full PUT replaces the guild command set (hubs + *_ub shortcuts in, folded flats out).
  for (const [, guild] of client.guilds.cache) {
    await rest
      .put(Routes.applicationGuildCommands(appId, guild.id), { body: commands })
      .then(() => logger.info({
        guildId: guild.id,
        chatCount: chatNames.length,
        hubs: hubsPresent,
        ubSlashCount: ubSlash.length,
      }, "Guild slash commands registered"))
      .catch(err => logger.error({ err, guildId: guild.id }, "Guild command registration failed"));
  }
}
