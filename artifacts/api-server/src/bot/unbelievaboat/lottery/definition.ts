import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { LOTTERY_ADMIN_DEFAULT_PERMISSIONS } from "./access.js";

export function buildLotteryCommandJson() {
  return new SlashCommandBuilder()
    .setName("lottery")
    .setDescription("UB Lottery — tickets, scratchers, Powerball & Mega Millionaire")
    .setDMPermission(false)
    .toJSON();
}

export function buildLotteryAdminCommandJson() {
  return new SlashCommandBuilder()
    .setName("lotteryadmin")
    .setDescription("Admin: lottery pools, channel, weekly Powerball reveal")
    .setDMPermission(false)
    .setDefaultMemberPermissions(LOTTERY_ADMIN_DEFAULT_PERMISSIONS)
    .toJSON();
}

// Keep PermissionFlagsBits import used (default perms already cover admin).
void PermissionFlagsBits;
