import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { CardViewerProvider } from "@/features/viewer/viewer-context";
import { CardViewer } from "@/features/viewer/CardViewer";
import { ThemeApplier } from "@/features/site/ThemeApplier";

import Home from "@/pages/home";
import Vault from "@/pages/vault";
import Play from "@/pages/play";
import Leaderboard from "@/pages/leaderboard";
import Profile from "@/pages/profile";
import Admin from "@/pages/admin";
import Login from "@/pages/login";
import Setup from "@/pages/setup";
import Users from "@/pages/users";
import Events from "@/pages/events";
import News from "@/pages/news";
import NewsDetail from "@/pages/news-detail";
import NewsAdmin from "@/pages/news-admin";
import SiteAdmin from "@/pages/site-admin";
import Suggestions from "@/pages/suggestions";
import SuggestionsAdmin from "@/pages/suggestions-admin";
import MakeEmoji from "@/pages/make-emoji";
import UnbelievaBoatAdmin from "@/pages/unbelievaboat-admin";
import BadgesAdmin from "@/pages/badges-admin";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 5, // 5 minutes
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/vault" component={Vault} />
      <Route path="/play" component={Play} />
      <Route path="/leaderboard" component={Leaderboard} />
      <Route path="/events" component={Events} />
      <Route path="/news" component={News} />
      <Route path="/news/:slug" component={NewsDetail} />
      <Route path="/suggestions" component={Suggestions} />
      <Route path="/profile" component={Profile} />
      <Route path="/login" component={Login} />
      <Route path="/setup/:token" component={Setup} />
      <Route path="/admin/users" component={Users} />
      <Route path="/admin/news" component={NewsAdmin} />
      <Route path="/admin/appearance" component={SiteAdmin} />
      <Route path="/admin/suggestions" component={SuggestionsAdmin} />
      <Route path="/admin/emoji" component={MakeEmoji} />
      <Route path="/admin/unbelievaboat" component={UnbelievaBoatAdmin} />
      <Route path="/admin/badges" component={BadgesAdmin} />
      <Route path="/admin" component={Admin} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeApplier />
        <CardViewerProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Layout>
              <Router />
            </Layout>
          </WouterRouter>
          <CardViewer />
        </CardViewerProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
