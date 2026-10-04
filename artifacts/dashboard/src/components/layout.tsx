import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useDiscordAuth } from "@/features/auth/useDiscordAuth";

function DiscordAuthControls() {
  const { configured, user, isLoggedIn, login, logout } = useDiscordAuth();
  if (!configured) return null;
  if (isLoggedIn && user) {
    const avatarUrl = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null;
    return (
      <div className="flex items-center gap-2">
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="h-6 w-6 rounded-full border border-border/60" />
        ) : (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
            {(user.username ?? "?").slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="hidden max-w-[10rem] truncate text-muted-foreground sm:inline">{user.username}</span>
        <button onClick={() => logout.mutate()} className="uppercase tracking-widest text-foreground/60 hover:text-foreground" data-testid="discord-logout">
          Log out
        </button>
      </div>
    );
  }
  return (
    <button
      onClick={login}
      className="flex items-center gap-2 rounded-md bg-[#5865F2] px-3 py-1.5 font-semibold uppercase tracking-widest text-white transition-opacity hover:opacity-90"
      data-testid="discord-login"
    >
      Login with Discord
    </button>
  );
}

export function Nav() {
  const [location] = useLocation();
  const { user, isOwner, logout } = useAuth();

  const links: { href: string; label: string; show: boolean }[] = [
    { href: "/", label: "Home", show: true },
    { href: "/vault", label: "Card Vault", show: true },
    { href: "/play", label: "Play", show: true },
    { href: "/leaderboard", label: "Leaderboard", show: true },
    { href: "/events", label: "Events", show: true },
    { href: "/news", label: "News", show: true },
    { href: "/suggestions", label: "Suggestions", show: true },
    { href: "/profile", label: "Profile", show: true },
    { href: "/admin", label: "Admin", show: !!user },
    { href: "/admin/emoji", label: "Make Emoji", show: !!user },
    { href: "/admin/unbelievaboat", label: "UnbelievaBoat", show: !!user },
    { href: "/admin/badges", label: "Badges", show: !!user },
    { href: "/admin/appearance", label: "Appearance", show: !!user },
    { href: "/admin/news", label: "News Admin", show: !!user },
    { href: "/admin/suggestions", label: "Suggestions Admin", show: !!user },
    { href: "/admin/users", label: "Users", show: isOwner },
  ];

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 max-w-screen-2xl items-center gap-4">
        <Link href="/" className="flex items-center space-x-2 shrink-0">
          <span className="hidden font-bold sm:inline-block text-primary tracking-wider uppercase">
            DEX N CARDS
          </span>
        </Link>
        <nav className="flex items-center gap-4 sm:gap-6 text-sm font-medium overflow-x-auto">
          {links.filter(l => l.show).map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`transition-colors hover:text-foreground/80 uppercase tracking-widest whitespace-nowrap ${
                location === link.href ? "text-foreground" : "text-foreground/60"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <DiscordAuthControls />
          {user ? (
            <>
              <span className="hidden sm:inline text-muted-foreground">{user.username}</span>
              <button
                onClick={() => logout.mutate()}
                className="text-foreground/60 hover:text-foreground uppercase tracking-widest"
              >
                Sign out
              </button>
            </>
          ) : (
            <Link href="/login" className="text-foreground/60 hover:text-foreground uppercase tracking-widest">
              Admin
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t py-6 md:py-0">
      <div className="container flex flex-col items-center justify-between gap-4 md:h-16 md:flex-row max-w-screen-2xl">
        <p className="text-sm leading-loose text-muted-foreground md:text-left tracking-wide">
          Dex N Cards Official · Collection viewer for our Discord community.
        </p>
      </div>
    </footer>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-[100dvh] flex-col bg-background">
      <Nav />
      <main className="flex-1">
        {children}
      </main>
      <Footer />
    </div>
  );
}
