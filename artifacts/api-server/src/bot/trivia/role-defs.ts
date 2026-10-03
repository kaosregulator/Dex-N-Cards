export const TRIVIA_ROLE_DEFS: Array<{
  key: string;
  name: string;
  color: number;
  reason: string;
}> = [
  { key: "trivia_winner", name: "Trivia Winner", color: 0x5865f2, reason: "Won a hosted trivia round" },
  { key: "qotd_champion", name: "QOTD Champion", color: 0xf1c40f, reason: "Won Question of the Day" },
  { key: "flash_champ", name: "Flash Champ", color: 0xe67e22, reason: "Won a flash quiz" },
  { key: "smart_cookie", name: "Smart Cookie", color: 0x2ecc71, reason: "Community smart cookie" },
  { key: "brainiac", name: "Brainiac", color: 0x9b59b6, reason: "Brainiac of the round" },
];

export function roleKeyForMode(mode: string): string {
  if (mode === "qotd") return "qotd_champion";
  if (mode === "flash" || mode === "picture") return "flash_champ";
  if (mode === "prompt") return "smart_cookie";
  return "trivia_winner";
}
