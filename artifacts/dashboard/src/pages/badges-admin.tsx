import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminGet, adminSend, ApiError } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type BadgeRule = {
  id: string;
  name: string;
  emoji: string;
  description: string;
  trigger: string;
  threshold: number;
  channel?: string | null;
  triviaMode?: string | null;
};

type BadgeStatus = {
  settings: {
    enabled: boolean;
    staffRoleId: string | null;
    trackChannelId: string | null;
    tradeChannelId: string | null;
    maxAttachmentsPerPost: number;
    uploadCooldownSeconds: number;
  };
  rules: BadgeRule[];
  defaults: BadgeRule[];
  triggers: string[];
};

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual (staff award)",
  messages: "Messages in channel",
  attachments: "Attachments in channel",
  reactions: "Reactions on one message",
  streak: "Consecutive active days",
  collection: "Earn every other badge",
  trivia: "Trivia win",
};

const EMPTY_RULE: BadgeRule = {
  id: "",
  name: "",
  emoji: "🏅",
  description: "",
  trigger: "manual",
  threshold: 0,
  channel: null,
  triviaMode: null,
};

export default function BadgesAdmin() {
  const [, navigate] = useLocation();
  const { user, isLoading } = useAuth();
  const qc = useQueryClient();
  const [flash, setFlash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rules, setRules] = useState<BadgeRule[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [staffRoleId, setStaffRoleId] = useState("");
  const [trackChannelId, setTrackChannelId] = useState("");
  const [tradeChannelId, setTradeChannelId] = useState("");
  const [maxAttachments, setMaxAttachments] = useState("3");
  const [cooldown, setCooldown] = useState("5");

  const status = useQuery<BadgeStatus>({
    queryKey: ["badges", "status"],
    queryFn: () => adminGet<BadgeStatus>("/api/admin/badges/status"),
    enabled: !!user,
  });

  useEffect(() => {
    if (!status.data) return;
    setRules(status.data.rules.map(r => ({ ...r })));
    setEnabled(status.data.settings.enabled);
    setStaffRoleId(status.data.settings.staffRoleId ?? "");
    setTrackChannelId(status.data.settings.trackChannelId ?? "");
    setTradeChannelId(status.data.settings.tradeChannelId ?? "");
    setMaxAttachments(String(status.data.settings.maxAttachmentsPerPost));
    setCooldown(String(status.data.settings.uploadCooldownSeconds));
  }, [status.data]);

  const saveSettings = useMutation({
    mutationFn: () => adminSend("PATCH", "/api/admin/badges/settings", {
      enabled,
      staffRoleId: staffRoleId.trim() || null,
      trackChannelId: trackChannelId.trim() || null,
      tradeChannelId: tradeChannelId.trim() || null,
      maxAttachmentsPerPost: Number(maxAttachments) || 3,
      uploadCooldownSeconds: Number(cooldown) || 0,
    }),
    onSuccess: () => {
      setFlash("Settings saved.");
      setErr(null);
      void qc.invalidateQueries({ queryKey: ["badges"] });
    },
    onError: (e: unknown) => {
      setErr(e instanceof ApiError ? e.message : "Failed to save settings");
    },
  });

  const saveRules = useMutation({
    mutationFn: () => adminSend("PUT", "/api/admin/badges/rules", { rules }),
    onSuccess: (data: { rules: BadgeRule[] }) => {
      setRules(data.rules);
      setFlash("Badge catalogue saved.");
      setErr(null);
      void qc.invalidateQueries({ queryKey: ["badges"] });
    },
    onError: (e: unknown) => {
      setErr(e instanceof ApiError ? e.message : "Failed to save rules");
    },
  });

  const resetRules = useMutation({
    mutationFn: () => adminSend("POST", "/api/admin/badges/rules/reset", {}),
    onSuccess: (data: { rules: BadgeRule[] }) => {
      setRules(data.rules);
      setFlash("Reset to default badge catalogue.");
      setErr(null);
      void qc.invalidateQueries({ queryKey: ["badges"] });
    },
    onError: (e: unknown) => {
      setErr(e instanceof ApiError ? e.message : "Failed to reset");
    },
  });

  if (isLoading) {
    return <div className="container py-10 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!user) {
    navigate("/login");
    return null;
  }

  function updateRule(index: number, patch: Partial<BadgeRule>) {
    setRules(prev => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeRule(index: number) {
    setRules(prev => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="container max-w-4xl py-8 space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Badges hub</h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Configure the emblem catalogue used in Discord. Badges are permanent and evolve from
          Lv.1–100 (Kindling → Apex) with animated emblems — no roles, no cash economy. Staff use{" "}
          <code className="text-xs">/badge give</code>; members view with{" "}
          <code className="text-xs">/badges</code> or <code className="text-xs">/badge show</code>.
        </p>
      </header>

      {(flash || err) && (
        <div className={`text-sm rounded-md px-3 py-2 ${err ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>
          {err ?? flash}
        </div>
      )}

      <section className="space-y-4 border border-border/50 rounded-xl p-5">
        <h2 className="font-medium">Settings</h2>
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label>Enabled</Label>
            <p className="text-xs text-muted-foreground">Turn off to pause awards and auto-triggers.</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="staffRole">Staff role ID (can give/take)</Label>
            <Input id="staffRole" value={staffRoleId} onChange={e => setStaffRoleId(e.target.value)} placeholder="Discord role snowflake" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="trackCh">Legacy track channel ID</Label>
            <Input id="trackCh" value={trackChannelId} onChange={e => setTrackChannelId(e.target.value)} placeholder="Fallback for messages/reactions" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tradeCh">Legacy trade channel ID</Label>
            <Input id="tradeCh" value={tradeChannelId} onChange={e => setTradeChannelId(e.target.value)} placeholder="Fallback for attachments" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="maxAtt">Max attachments per post</Label>
            <Input id="maxAtt" value={maxAttachments} onChange={e => setMaxAttachments(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cooldown">Upload cooldown (seconds)</Label>
            <Input id="cooldown" value={cooldown} onChange={e => setCooldown(e.target.value)} />
          </div>
        </div>
        <Button onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}>
          {saveSettings.isPending ? "Saving…" : "Save settings"}
        </Button>
      </section>

      <section className="space-y-4 border border-border/50 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">Badge catalogue</h2>
            <p className="text-xs text-muted-foreground">Up to 25 rules. Stable IDs are lowercase letters, numbers, underscore.</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRules(prev => [...prev, { ...EMPTY_RULE, id: `badge_${prev.length + 1}` }])}
              disabled={rules.length >= 25}
            >
              Add badge
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirm("Reset catalogue to defaults (including trivia badges)?")) resetRules.mutate();
              }}
              disabled={resetRules.isPending}
            >
              Reset defaults
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          {rules.map((rule, index) => (
            <div key={`${rule.id}-${index}`} className="border border-border/40 rounded-lg p-4 space-y-3 bg-muted/20">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{rule.emoji} {rule.name || "Untitled"}</span>
                <Button variant="ghost" size="sm" onClick={() => removeRule(index)}>Remove</Button>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>ID</Label>
                  <Input value={rule.id} onChange={e => updateRule(index, { id: e.target.value.toLowerCase() })} />
                </div>
                <div className="space-y-1">
                  <Label>Name</Label>
                  <Input value={rule.name} onChange={e => updateRule(index, { name: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label>Emoji</Label>
                  <Input value={rule.emoji} onChange={e => updateRule(index, { emoji: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label>Trigger</Label>
                  <Select value={rule.trigger} onValueChange={v => updateRule(index, { trigger: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(status.data?.triggers ?? Object.keys(TRIGGER_LABELS)).map(t => (
                        <SelectItem key={t} value={t}>{TRIGGER_LABELS[t] ?? t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label>Description</Label>
                  <Input value={rule.description} onChange={e => updateRule(index, { description: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label>Threshold</Label>
                  <Input
                    type="number"
                    value={String(rule.threshold)}
                    onChange={e => updateRule(index, { threshold: Number(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Channel ID (messages / attachments / reactions)</Label>
                  <Input
                    value={rule.channel ?? ""}
                    onChange={e => updateRule(index, { channel: e.target.value || null })}
                    placeholder="Optional Discord channel id"
                  />
                </div>
                {rule.trigger === "trivia" && (
                  <div className="space-y-1">
                    <Label>Trivia mode</Label>
                    <Select
                      value={rule.triviaMode ?? "any"}
                      onValueChange={v => updateRule(index, { triviaMode: v === "any" ? "any" : v })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["any", "trivia", "qotd", "flash", "prompt", "brainiac"].map(m => (
                          <SelectItem key={m} value={m}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            </div>
          ))}
          {!rules.length && (
            <p className="text-sm text-muted-foreground">No badges yet — add one or reset to defaults.</p>
          )}
        </div>

        <Button onClick={() => saveRules.mutate()} disabled={saveRules.isPending}>
          {saveRules.isPending ? "Saving…" : "Save catalogue"}
        </Button>
      </section>
    </div>
  );
}
