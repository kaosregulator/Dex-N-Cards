import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminGet, adminSend, ApiError } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type UbStatus = {
  configured: boolean;
  settings: {
    ubGuildId: string;
    enabled: boolean;
    leaderboardSort: string;
    petsSpendUb: boolean;
    currencyLabel: string | null;
  };
  petSettings: {
    enabled: boolean;
    hatchCost: number;
    growthHours: number;
    maxNeglects: number;
    challengeWager: number;
    hungerDecayPerHour: number;
    cleanlinessDecayPerHour: number;
    happinessDecayPerHour: number;
  };
  guild: { id: string; name: string; symbol: string; member_count: number } | null;
  apiError: string | null;
  docs: string;
};

type LbEntry = { rank: string; user_id: string; cash: number; bank: number; total: number };
type RoleLink = {
  id: number; name: string; description: string | null; discordRoleId: string | null;
  ubItemId: string | null; price: number; grantCash: number; category: string;
  emoji: string | null; enabled: boolean;
};
type CatalogItem = {
  id: number; name: string; description: string | null; price: number; emoji: string | null;
  category: string; ubItemId: string | null; grantRoleId: string | null; forPets: boolean;
  petEffect: string | null; listed: boolean;
};

function fmt(n: number) {
  return new Intl.NumberFormat().format(n);
}

export default function UnbelievaBoatAdmin() {
  const [, navigate] = useLocation();
  const { user, isLoading } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState("overview");
  const [sort, setSort] = useState<"cash" | "bank" | "total">("total");
  const [flash, setFlash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // User editor
  const [editUserId, setEditUserId] = useState("");
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
  const [cashDelta, setCashDelta] = useState("");
  const [bankDelta, setBankDelta] = useState("");
  const [setCash, setSetCash] = useState("");
  const [setBank, setSetBank] = useState("");
  const [reason, setReason] = useState("Dashboard hub adjust");

  // Role form
  const [roleName, setRoleName] = useState("");
  const [roleDiscordId, setRoleDiscordId] = useState("");
  const [rolePrice, setRolePrice] = useState("500");
  const [roleEmoji, setRoleEmoji] = useState("⭐");
  const [roleCategory, setRoleCategory] = useState("vip");
  const [roleSync, setRoleSync] = useState(true);
  const [roleDesc, setRoleDesc] = useState("");

  // Catalog form
  const [catName, setCatName] = useState("");
  const [catPrice, setCatPrice] = useState("100");
  const [catEmoji, setCatEmoji] = useState("🎁");
  const [catForPets, setCatForPets] = useState(false);
  const [catEffect, setCatEffect] = useState("food");
  const [catDesc, setCatDesc] = useState("");
  const [catGrantRole, setCatGrantRole] = useState("");

  const status = useQuery<UbStatus>({
    queryKey: ["ub", "status"],
    queryFn: () => adminGet<UbStatus>("/api/admin/ub/status"),
    enabled: !!user,
  });

  const leaderboard = useQuery<{ sort: string; data: LbEntry[] | { users: LbEntry[]; total_pages: number } }>({
    queryKey: ["ub", "leaderboard", sort],
    queryFn: () => adminGet(`/api/admin/ub/leaderboard?sort=${sort}&page=1&limit=50`),
    enabled: !!user && tab === "leaderboard" && !!status.data?.configured,
  });

  const roles = useQuery<{ roles: RoleLink[] }>({
    queryKey: ["ub", "roles"],
    queryFn: () => adminGet("/api/admin/ub/roles"),
    enabled: !!user && (tab === "roles" || tab === "overview"),
  });

  const store = useQuery<{ local: CatalogItem[]; remote: any[]; remoteError: string | null; configured: boolean }>({
    queryKey: ["ub", "store"],
    queryFn: () => adminGet("/api/admin/ub/store"),
    enabled: !!user && tab === "store",
  });

  const pets = useQuery<{
    leaderboard: { userId: string; name: string; species: string; stage: string; level: number; power: number; wins: number }[];
    settings: UbStatus["petSettings"];
  }>({
    queryKey: ["ub", "pets"],
    queryFn: () => adminGet("/api/admin/ub/pets"),
    enabled: !!user && tab === "pets",
  });

  const audit = useQuery<{ rows: { id: number; action: string; actorId: string; targetUserId: string | null; createdAt: string }[] }>({
    queryKey: ["ub", "audit"],
    queryFn: () => adminGet("/api/admin/ub/audit"),
    enabled: !!user && tab === "audit",
  });

  type UserBalanceView = {
    balance: { user_id: string; cash: number; bank: number; total: number; rank?: string };
    inventory: unknown[];
  };

  const userBalance = useQuery<UserBalanceView>({
    queryKey: ["ub", "user", loadedUserId],
    queryFn: () => adminGet(`/api/admin/ub/users/${loadedUserId}`),
    enabled: !!user && !!loadedUserId && !!status.data?.configured,
  });

  function note(msg: string) {
    setFlash(msg);
    setErr(null);
    setTimeout(() => setFlash(null), 3500);
  }
  function fail(e: unknown) {
    setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Request failed");
  }

  function loadUser() {
    const id = editUserId.trim();
    if (!id) {
      setErr("Enter a Discord user ID first.");
      return;
    }
    setLoadedUserId(id);
    setErr(null);
  }

  const patchSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) => adminSend("PATCH", "/api/admin/ub/settings", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ub", "status"] }); note("Settings saved"); },
    onError: fail,
  });

  const patchPetSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) => adminSend("PATCH", "/api/admin/ub/pet-settings", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ub", "status"] }); qc.invalidateQueries({ queryKey: ["ub", "pets"] }); note("Pet settings saved"); },
    onError: fail,
  });

  const adjustUser = useMutation({
    mutationFn: (body: { mode: "patch" | "set"; cash?: number; bank?: number; reason?: string }) =>
      adminSend<{ balance: UserBalanceView["balance"] }>("PATCH", `/api/admin/ub/users/${editUserId.trim()}`, body),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["ub", "leaderboard"] });
      qc.invalidateQueries({ queryKey: ["ub", "user", editUserId.trim()] });
      qc.invalidateQueries({ queryKey: ["ub", "audit"] });
      if (data?.balance) {
        setSetCash(String(data.balance.cash));
        setSetBank(String(data.balance.bank));
      }
      note("Balance updated");
    },
    onError: fail,
  });

  const createRole = useMutation({
    mutationFn: () => adminSend("POST", "/api/admin/ub/roles", {
      name: roleName,
      discordRoleId: roleDiscordId || null,
      price: Number(rolePrice) || 0,
      emoji: roleEmoji || null,
      category: roleCategory,
      description: roleDesc || null,
      syncToStore: roleSync,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ub", "roles"] });
      setRoleName(""); setRoleDiscordId(""); setRoleDesc("");
      note("Role link created");
    },
    onError: fail,
  });

  const deleteRole = useMutation({
    mutationFn: (id: number) => adminSend("DELETE", `/api/admin/ub/roles/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ub", "roles"] }); note("Role removed"); },
    onError: fail,
  });

  const createCatalog = useMutation({
    mutationFn: () => adminSend("POST", "/api/admin/ub/catalog", {
      name: catName,
      price: Number(catPrice) || 0,
      emoji: catEmoji || null,
      description: catDesc || null,
      forPets: catForPets,
      petEffect: catForPets ? catEffect : null,
      grantRoleId: catGrantRole || null,
      listed: true,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ub", "store"] });
      setCatName(""); setCatDesc(""); setCatGrantRole("");
      note("Catalog item added");
    },
    onError: fail,
  });

  const syncCatalog = useMutation({
    mutationFn: (id: number) => adminSend("POST", `/api/admin/ub/catalog/${id}/sync`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ub", "store"] }); note("Synced to UnbelievaBoat store"); },
    onError: fail,
  });

  const deleteCatalog = useMutation({
    mutationFn: (id: number) => adminSend("DELETE", `/api/admin/ub/catalog/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ub", "store"] }); note("Removed"); },
    onError: fail,
  });

  const lbRows = useMemo(() => {
    const raw = leaderboard.data?.data;
    if (!raw) return [] as LbEntry[];
    if (Array.isArray(raw)) return raw;
    return raw.users ?? [];
  }, [leaderboard.data]);

  if (isLoading) return <div className="container py-12 text-center text-muted-foreground">Loading…</div>;
  if (!user) {
    return (
      <div className="container max-w-md py-12 px-4 text-center">
        <p className="mb-4">Sign in to open the UnbelievaBoat hub.</p>
        <Button onClick={() => navigate("/login")}>Sign in</Button>
      </div>
    );
  }

  const s = status.data;

  return (
    <div className="container max-w-6xl py-8 px-4 space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">UnbelievaBoat Hub</h1>
          <p className="text-sm text-muted-foreground">
            Official admin control for economy, leaderboards, role links, store catalog, and the Tamagotchi pet addon.
            Addon only — does not replace DN Cards.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={s?.configured ? "default" : "secondary"}>
            {s?.configured ? "API token ready" : "Token pending"}
          </Badge>
          {s?.guild && <Badge variant="outline">{s.guild.name}</Badge>}
        </div>
      </div>

      {(flash || err || s?.apiError) && (
        <div className={`rounded-md border px-4 py-3 text-sm ${err || s?.apiError ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border bg-muted/40"}`}>
          {err ?? flash ?? s?.apiError}
        </div>
      )}

      {!s?.configured && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          Set <code className="font-mono">UNBELIEVABOAT_TOKEN</code> on Railway to unlock live leaderboard / balance / store sync.
          Local roles, catalog, and pets still work offline. Docs:{" "}
          <a className="underline" href={s?.docs ?? "https://api-docs.unbelievaboat.com/reference/reference"} target="_blank" rel="noreferrer">
            api-docs.unbelievaboat.com
          </a>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto flex-wrap gap-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="leaderboard">Leaderboard</TabsTrigger>
          <TabsTrigger value="users">Edit Users</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="store">Store</TabsTrigger>
          <TabsTrigger value="pets">Pets</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 pt-4">
          <div className="grid gap-4 md:grid-cols-2">
            <section className="space-y-4 rounded-lg border p-4">
              <h2 className="font-semibold">Economy settings</h2>
              <div className="flex items-center justify-between gap-3">
                <Label>Hub enabled</Label>
                <Switch
                  checked={!!s?.settings.enabled}
                  onCheckedChange={(v) => patchSettings.mutate({ enabled: v })}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label>Pets spend UB cash</Label>
                <Switch
                  checked={!!s?.settings.petsSpendUb}
                  onCheckedChange={(v) => patchSettings.mutate({ petsSpendUb: v })}
                />
              </div>
              <div className="space-y-2">
                <Label>UB guild ID</Label>
                <div className="flex gap-2">
                  <Input
                    defaultValue={s?.settings.ubGuildId ?? ""}
                    id="ub-guild"
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const el = document.getElementById("ub-guild") as HTMLInputElement | null;
                      if (el?.value) patchSettings.mutate({ ubGuildId: el.value.trim() });
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Default leaderboard sort</Label>
                <Select
                  value={s?.settings.leaderboardSort ?? "total"}
                  onValueChange={(v) => patchSettings.mutate({ leaderboardSort: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="total">Total</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="bank">Bank</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {s?.guild && (
                <p className="text-xs text-muted-foreground">
                  Connected to <strong>{s.guild.name}</strong> · symbol {s.guild.symbol} · {fmt(s.guild.member_count)} members
                </p>
              )}
            </section>

            <section className="space-y-3 rounded-lg border p-4">
              <h2 className="font-semibold">Quick links</h2>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>• Discord: <code>/pet</code> hub · <code>/pet hatch</code> · <code>/pet challenge</code> · <code>/petadmin</code></li>
                <li>• <strong>Edit Users</strong> — load a member, then adjust/set/clear <strong>cash & bank</strong> (UB PATCH/PUT).</li>
                <li>• Create Discord role links and optionally push an UnbelievaBoat store item that grants the role.</li>
                <li>• Author local catalog items (including pet shop goods), then Sync to UB when the token is live.</li>
              </ul>
              <div className="pt-2">
                <p className="text-xs uppercase tracking-widest text-muted-foreground mb-2">Role links</p>
                <div className="flex flex-wrap gap-2">
                  {(roles.data?.roles ?? []).slice(0, 8).map(r => (
                    <Badge key={r.id} variant={r.enabled ? "default" : "secondary"}>
                      {r.emoji ?? "•"} {r.name}
                    </Badge>
                  ))}
                  {!roles.data?.roles?.length && <span className="text-xs text-muted-foreground">None yet</span>}
                </div>
              </div>
            </section>
          </div>
        </TabsContent>

        <TabsContent value="leaderboard" className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <Label>Sort</Label>
            <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="total">Total</SelectItem>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="bank">Bank</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="secondary" size="sm" onClick={() => leaderboard.refetch()}>Refresh</Button>
          </div>
          {!s?.configured ? (
            <p className="text-sm text-muted-foreground">Connect <code>UNBELIEVABOAT_TOKEN</code> to load the live leaderboard.</p>
          ) : leaderboard.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">User</th>
                    <th className="px-3 py-2">Cash</th>
                    <th className="px-3 py-2">Bank</th>
                    <th className="px-3 py-2">Total</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {lbRows.map((u) => (
                    <tr key={u.user_id} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs">{u.rank}</td>
                      <td className="px-3 py-2 font-mono text-xs">{u.user_id}</td>
                      <td className="px-3 py-2">{fmt(u.cash)}</td>
                      <td className="px-3 py-2">{fmt(u.bank)}</td>
                      <td className="px-3 py-2 font-medium">{fmt(u.total)}</td>
                      <td className="px-3 py-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditUserId(u.user_id);
                            setLoadedUserId(u.user_id);
                            setSetCash(String(u.cash));
                            setSetBank(String(u.bank));
                            setTab("users");
                          }}
                        >
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="users" className="space-y-4 pt-4">
          <section className="max-w-2xl space-y-5 rounded-lg border p-5">
            <div>
              <h2 className="font-semibold text-lg">Edit user</h2>
              <p className="text-xs text-muted-foreground mt-1">
                UnbelievaBoat economy fields you can change: <strong>cash</strong>, <strong>bank</strong>, and optional <strong>reason</strong> (audit).
                Total &amp; rank are read-only. There is no delete-user API — reset means set cash/bank to 0.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Discord user ID</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  className="font-mono text-xs flex-1 min-w-[12rem]"
                  value={editUserId}
                  onChange={(e) => setEditUserId(e.target.value)}
                  placeholder="snowflake"
                  onKeyDown={(e) => { if (e.key === "Enter") loadUser(); }}
                />
                <Button variant="secondary" disabled={!editUserId.trim() || !s?.configured} onClick={loadUser}>
                  Load balance
                </Button>
              </div>
            </div>

            {!s?.configured ? (
              <p className="text-sm text-muted-foreground">Connect <code>UNBELIEVABOAT_TOKEN</code> to edit live balances.</p>
            ) : loadedUserId && userBalance.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading balance…</p>
            ) : userBalance.data?.balance ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-md border bg-muted/30 p-3 text-sm">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Rank</p>
                  <p className="font-medium">#{userBalance.data.balance.rank ?? "—"}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Cash</p>
                  <p className="font-medium tabular-nums">{fmt(userBalance.data.balance.cash)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Bank</p>
                  <p className="font-medium tabular-nums">{fmt(userBalance.data.balance.bank)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total</p>
                  <p className="font-semibold tabular-nums">{fmt(userBalance.data.balance.total)}</p>
                </div>
              </div>
            ) : loadedUserId && userBalance.isError ? (
              <p className="text-sm text-destructive">Could not load that user — check the ID and API token.</p>
            ) : null}

            <div className="space-y-2">
              <Label>Reason (audit log)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this change?" />
            </div>

            <div className="space-y-3 border-t pt-4">
              <h3 className="text-sm font-medium">Adjust (±) — PATCH</h3>
              <p className="text-xs text-muted-foreground">Add or remove from cash and/or bank. Leave a field blank to skip it.</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Cash delta</Label>
                  <Input value={cashDelta} onChange={(e) => setCashDelta(e.target.value)} placeholder="+100 or -50" />
                </div>
                <div className="space-y-2">
                  <Label>Bank delta</Label>
                  <Input value={bankDelta} onChange={(e) => setBankDelta(e.target.value)} placeholder="+250 or -25" />
                </div>
              </div>
              <Button
                disabled={!editUserId.trim() || adjustUser.isPending || (cashDelta === "" && bankDelta === "")}
                onClick={() => {
                  const cash = cashDelta === "" ? undefined : Number(cashDelta);
                  const bank = bankDelta === "" ? undefined : Number(bankDelta);
                  if ((cash !== undefined && !Number.isFinite(cash)) || (bank !== undefined && !Number.isFinite(bank))) {
                    setErr("Cash/bank deltas must be numbers.");
                    return;
                  }
                  if ((cash ?? 0) === 0 && (bank ?? 0) === 0) {
                    setErr("Enter a non-zero cash and/or bank delta.");
                    return;
                  }
                  adjustUser.mutate({ mode: "patch", cash, bank, reason: reason || "Dashboard hub adjust" });
                }}
              >
                Apply delta
              </Button>
            </div>

            <div className="space-y-3 border-t pt-4">
              <h3 className="text-sm font-medium">Set absolute — PUT</h3>
              <p className="text-xs text-muted-foreground">Overwrite cash and/or bank to exact values. Blank = leave unchanged.</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Cash</Label>
                  <Input value={setCash} onChange={(e) => setSetCash(e.target.value)} placeholder="exact amount" />
                </div>
                <div className="space-y-2">
                  <Label>Bank</Label>
                  <Input value={setBank} onChange={(e) => setSetBank(e.target.value)} placeholder="exact amount" />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={!editUserId.trim() || adjustUser.isPending || (setCash === "" && setBank === "")}
                  onClick={() => {
                    const cash = setCash === "" ? undefined : Number(setCash);
                    const bank = setBank === "" ? undefined : Number(setBank);
                    if ((cash !== undefined && (!Number.isFinite(cash) || cash < 0))
                      || (bank !== undefined && (!Number.isFinite(bank) || bank < 0))) {
                      setErr("Absolute cash/bank must be non-negative numbers.");
                      return;
                    }
                    adjustUser.mutate({ mode: "set", cash, bank, reason: reason || "Dashboard hub set" });
                  }}
                >
                  Set balances
                </Button>
                {userBalance.data?.balance && (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => {
                      setSetCash(String(userBalance.data!.balance.cash));
                      setSetBank(String(userBalance.data!.balance.bank));
                    }}
                  >
                    Fill from current
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-3 border-t pt-4">
              <h3 className="text-sm font-medium">Quick clear / reset</h3>
              <p className="text-xs text-muted-foreground">Uses Set (PUT) to zero. No separate clear endpoint on UnbelievaBoat.</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!editUserId.trim() || adjustUser.isPending}
                  onClick={() => adjustUser.mutate({ mode: "set", cash: 0, reason: reason || "Dashboard clear cash" })}
                >
                  Clear cash → 0
                </Button>
                <Button
                  variant="outline"
                  disabled={!editUserId.trim() || adjustUser.isPending}
                  onClick={() => adjustUser.mutate({ mode: "set", bank: 0, reason: reason || "Dashboard clear bank" })}
                >
                  Clear bank → 0
                </Button>
                <Button
                  variant="destructive"
                  disabled={!editUserId.trim() || adjustUser.isPending}
                  onClick={() => {
                    if (!window.confirm(`Reset cash and bank to 0 for ${editUserId.trim()}?`)) return;
                    adjustUser.mutate({ mode: "set", cash: 0, bank: 0, reason: reason || "Dashboard reset all" });
                  }}
                >
                  Reset all → 0
                </Button>
              </div>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="roles" className="space-y-4 pt-4">
          <section className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3 rounded-lg border p-4">
              <h2 className="font-semibold">Link a Discord role to the economy</h2>
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={roleName} onChange={(e) => setRoleName(e.target.value)} placeholder="VIP Member" />
              </div>
              <div className="space-y-2">
                <Label>Discord role ID</Label>
                <Input className="font-mono text-xs" value={roleDiscordId} onChange={(e) => setRoleDiscordId(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Price (cash)</Label>
                  <Input value={rolePrice} onChange={(e) => setRolePrice(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Emoji</Label>
                  <Input value={roleEmoji} onChange={(e) => setRoleEmoji(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Category</Label>
                <Select value={roleCategory} onValueChange={setRoleCategory}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vip">VIP</SelectItem>
                    <SelectItem value="perk">Perk</SelectItem>
                    <SelectItem value="cosmetic">Cosmetic</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea value={roleDesc} onChange={(e) => setRoleDesc(e.target.value)} rows={2} />
              </div>
              <div className="flex items-center justify-between">
                <Label>Also create UB store item (grants role)</Label>
                <Switch checked={roleSync} onCheckedChange={setRoleSync} />
              </div>
              <Button disabled={!roleName || createRole.isPending} onClick={() => createRole.mutate()}>
                Create role link
              </Button>
            </div>
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="px-3 py-2">Role</th>
                    <th className="px-3 py-2">Price</th>
                    <th className="px-3 py-2">UB item</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {(roles.data?.roles ?? []).map(r => (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2">{r.emoji} {r.name}<div className="font-mono text-[10px] text-muted-foreground">{r.discordRoleId}</div></td>
                      <td className="px-3 py-2">{fmt(r.price)}</td>
                      <td className="px-3 py-2 font-mono text-[10px]">{r.ubItemId ?? "—"}</td>
                      <td className="px-3 py-2">
                        <Button size="sm" variant="ghost" onClick={() => deleteRole.mutate(r.id)}>Remove</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="store" className="space-y-4 pt-4">
          <section className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3 rounded-lg border p-4">
              <h2 className="font-semibold">Add catalog item (local)</h2>
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={catName} onChange={(e) => setCatName(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Price</Label>
                  <Input value={catPrice} onChange={(e) => setCatPrice(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Emoji</Label>
                  <Input value={catEmoji} onChange={(e) => setCatEmoji(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Grant Discord role ID (optional)</Label>
                <Input className="font-mono text-xs" value={catGrantRole} onChange={(e) => setCatGrantRole(e.target.value)} />
              </div>
              <div className="flex items-center justify-between">
                <Label>For pet shop</Label>
                <Switch checked={catForPets} onCheckedChange={setCatForPets} />
              </div>
              {catForPets && (
                <div className="space-y-2">
                  <Label>Pet effect</Label>
                  <Select value={catEffect} onValueChange={setCatEffect}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="food">Food</SelectItem>
                      <SelectItem value="feast">Feast</SelectItem>
                      <SelectItem value="soap">Soap</SelectItem>
                      <SelectItem value="toy">Toy</SelectItem>
                      <SelectItem value="medicine">Medicine</SelectItem>
                      <SelectItem value="ribbon">Ribbon</SelectItem>
                      <SelectItem value="hat">Hat</SelectItem>
                      <SelectItem value="armor">Armor</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea value={catDesc} onChange={(e) => setCatDesc(e.target.value)} rows={2} />
              </div>
              <Button disabled={!catName || createCatalog.isPending} onClick={() => createCatalog.mutate()}>
                Add to catalog
              </Button>
            </div>
            <div className="space-y-3">
              <h2 className="font-semibold">Local catalog</h2>
              <div className="rounded-md border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left">
                    <tr>
                      <th className="px-3 py-2">Item</th>
                      <th className="px-3 py-2">Price</th>
                      <th className="px-3 py-2">UB</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {(store.data?.local ?? []).map(item => (
                      <tr key={item.id} className="border-t">
                        <td className="px-3 py-2">
                          {item.emoji} {item.name}
                          {item.forPets && <Badge className="ml-2" variant="secondary">pet</Badge>}
                        </td>
                        <td className="px-3 py-2">{fmt(item.price)}</td>
                        <td className="px-3 py-2 font-mono text-[10px]">{item.ubItemId ?? "local"}</td>
                        <td className="px-3 py-2 space-x-1">
                          <Button size="sm" variant="secondary" onClick={() => syncCatalog.mutate(item.id)}>Sync</Button>
                          <Button size="sm" variant="ghost" onClick={() => deleteCatalog.mutate(item.id)}>Del</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {store.data?.remoteError && (
                <p className="text-xs text-destructive">{store.data.remoteError}</p>
              )}
              {!!store.data?.remote?.length && (
                <div>
                  <h3 className="text-sm font-medium mb-2">Live UnbelievaBoat store ({store.data.remote.length})</h3>
                  <ul className="max-h-48 overflow-y-auto space-y-1 text-xs text-muted-foreground">
                    {store.data.remote.map((it: any) => (
                      <li key={it.id}>{it.emoji_unicode ?? "•"} {it.name} — {it.price} cash</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="pets" className="space-y-4 pt-4">
          <section className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3 rounded-lg border p-4">
              <h2 className="font-semibold">Pet game settings</h2>
              <div className="flex items-center justify-between">
                <Label>Enabled</Label>
                <Switch
                  checked={!!(pets.data?.settings.enabled ?? s?.petSettings.enabled)}
                  onCheckedChange={(v) => patchPetSettings.mutate({ enabled: v })}
                />
              </div>
              {[
                ["hatchCost", "Hatch cost (UB cash)", pets.data?.settings.hatchCost ?? s?.petSettings.hatchCost],
                ["growthHours", "Hours per growth stage", pets.data?.settings.growthHours ?? s?.petSettings.growthHours],
                ["maxNeglects", "Neglects before death", pets.data?.settings.maxNeglects ?? s?.petSettings.maxNeglects],
                ["challengeWager", "Default challenge wager", pets.data?.settings.challengeWager ?? s?.petSettings.challengeWager],
              ].map(([key, label, val]) => (
                <div key={String(key)} className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label>{label}</Label>
                    <Input id={`pet-${key}`} defaultValue={String(val ?? 0)} type="number" />
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const el = document.getElementById(`pet-${key}`) as HTMLInputElement | null;
                      if (el) patchPetSettings.mutate({ [key as string]: Number(el.value) });
                    }}
                  >
                    Save
                  </Button>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Species: dragons, cats, dogs, hamsters. Animated GIF care hub via <code>/pet</code>.
                Pets decay in real time, hatch → adult, and can die after repeated neglect.
              </p>
            </div>
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="px-3 py-2">Pet</th>
                    <th className="px-3 py-2">Owner</th>
                    <th className="px-3 py-2">PWR</th>
                    <th className="px-3 py-2">W</th>
                  </tr>
                </thead>
                <tbody>
                  {(pets.data?.leaderboard ?? []).map((p, i) => (
                    <tr key={`${p.userId}-${i}`} className="border-t">
                      <td className="px-3 py-2">{p.name} <span className="text-muted-foreground">({p.species} · {p.stage})</span></td>
                      <td className="px-3 py-2 font-mono text-[10px]">{p.userId}</td>
                      <td className="px-3 py-2">{p.power}</td>
                      <td className="px-3 py-2">{p.wins}</td>
                    </tr>
                  ))}
                  {!pets.data?.leaderboard?.length && (
                    <tr><td className="px-3 py-4 text-muted-foreground" colSpan={4}>No living pets yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="audit" className="pt-4">
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Actor</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Target</th>
                </tr>
              </thead>
              <tbody>
                {(audit.data?.rows ?? []).map(r => (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.actorId}</td>
                    <td className="px-3 py-2">{r.action}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.targetUserId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
