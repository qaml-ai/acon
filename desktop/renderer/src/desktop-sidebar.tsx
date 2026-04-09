import type { ComponentType } from "react";
import {
  CircleHelp,
  Plus,
  Settings,
  TerminalSquare,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import type {
  DesktopSidebarPanel,
  DesktopSnapshot,
  DesktopThread,
  DesktopView,
} from "../../shared/protocol";
import { getDesktopIcon } from "./desktop-icons";
import { ThreadRuntimeIndicator } from "./thread-runtime-indicator";

interface DesktopSidebarProps {
  activeThreadId: string | null;
  activeViewId: string | null;
  connectionState: "connecting" | "open" | "closed";
  onCreateThread: () => void;
  onOpenSettings: () => void;
  onSelectThread: (threadId: string) => void;
  onSelectView: (viewId: string) => void;
  showSettings: boolean;
  sidebarPanels: DesktopSidebarPanel[];
  snapshot: DesktopSnapshot | null;
  threads: DesktopThread[];
  views: DesktopView[];
}

type SidebarPanelComponentProps = Pick<
  DesktopSidebarProps,
  | "activeThreadId"
  | "activeViewId"
  | "onCreateThread"
  | "onSelectThread"
  | "onSelectView"
  | "snapshot"
  | "threads"
  | "views"
> & {
  panel: DesktopSidebarPanel;
};

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function shouldShowRuntimeCard(snapshot: DesktopSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  return (
    snapshot.runtimeStatus.state !== "running" ||
    !snapshot.auth.available
  );
}

function ChatRecentThreadsSidebarPanel({
  activeThreadId,
  onCreateThread,
  onSelectThread,
  snapshot,
  threads,
}: Pick<
  SidebarPanelComponentProps,
  "activeThreadId" | "onCreateThread" | "onSelectThread" | "snapshot" | "threads"
>) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Recent Chats</SidebarGroupLabel>
      <SidebarGroupAction
        aria-label="Create new thread"
        onClick={onCreateThread}
      >
        <Plus />
      </SidebarGroupAction>
      <SidebarGroupContent>
        <SidebarMenu>
          {threads.map((thread) => {
            const runtime = snapshot?.threadRuntimeById[thread.id];

            return (
              <SidebarMenuItem key={thread.id}>
                <SidebarMenuButton
                  size="lg"
                  isActive={thread.id === activeThreadId}
                  tooltip={thread.title}
                  onClick={() => onSelectThread(thread.id)}
                  className="h-auto min-h-12"
                >
                  <span className="flex size-4 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
                    {thread.title.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="grid flex-1 min-w-0 text-left text-sm leading-tight">
                    <span className="flex items-center gap-1.5 truncate font-medium">
                      <span className="truncate">{thread.title}</span>
                      <ThreadRuntimeIndicator runtime={runtime} className="size-3" />
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {thread.lastMessagePreview ||
                        formatTime(thread.updatedAt)}
                    </span>
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

const SIDEBAR_HOST_COMPONENTS: Record<
  string,
  ComponentType<SidebarPanelComponentProps>
> = {
  "chat:recent-threads": ChatRecentThreadsSidebarPanel,
};

function SidebarPanelContent({
  panel,
}: {
  panel: DesktopSidebarPanel;
}) {
  const ViewIcon = getDesktopIcon(panel.icon);
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{panel.title}</SidebarGroupLabel>
      <SidebarGroupContent>
        <div className="space-y-2 px-2">
          {panel.description ? (
            <p className="text-xs text-muted-foreground">{panel.description}</p>
          ) : null}
          {panel.hostData?.sections.map((section) => (
            <div
              key={section.id}
              className="rounded-md border border-sidebar-border/70 bg-sidebar-accent/20 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <ViewIcon className="size-3.5" />
                <p className="text-xs font-medium text-sidebar-foreground">{section.title}</p>
              </div>
              {section.items.map((item) => (
                <div key={`${section.id}:${item.label}`} className="mt-2 text-xs">
                  <p className="text-muted-foreground">{item.label}</p>
                  <p className="break-all text-sidebar-foreground">{item.value}</p>
                </div>
              ))}
            </div>
          ))}
        </div>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function DesktopSidebar({
  activeThreadId,
  activeViewId,
  connectionState,
  onCreateThread,
  onOpenSettings,
  onSelectThread,
  onSelectView,
  showSettings,
  sidebarPanels,
  snapshot,
  threads,
  views,
}: DesktopSidebarProps) {
  const { state } = useSidebar();
  const workspaceViews = views.filter((view) => view.scope === "workspace");
  const contentPanels = sidebarPanels.filter((panel) => panel.placement === "content");
  const footerPanels = sidebarPanels.filter((panel) => panel.placement === "footer");

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Local Workspace"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar size="default">
                <AvatarFallback content="CA">CA</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Local Workspace</span>
                <span className="truncate text-xs text-muted-foreground">
                  camelAI Desktop
                </span>
              </div>
              <TerminalSquare className="ml-auto size-4" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div
          className="flex px-2 transition-[justify-content] duration-200 ease-in-out"
          style={{
            justifyContent: state === "expanded" ? "flex-start" : "center",
          }}
        >
          <Badge
            variant="secondary"
            className="tracking-wider font-semibold uppercase"
          >
            Beta
          </Badge>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workbench</SidebarGroupLabel>
          <SidebarMenu>
            {workspaceViews.map((view) => {
              const ViewIcon = getDesktopIcon(view.icon);
              return (
                <SidebarMenuItem key={view.id}>
                  <SidebarMenuButton
                    tooltip={view.title}
                    isActive={view.id === activeViewId}
                    onClick={() => onSelectView(view.id)}
                  >
                    <ViewIcon />
                    <span>{view.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarSeparator />
        {contentPanels.map((panel, index) => {
          const componentKey = panel.pluginId
            ? `${panel.pluginId}:${panel.render.component ?? ""}`
            : panel.render.component ?? "";
          const HostComponent =
            panel.render.kind === "host"
              ? SIDEBAR_HOST_COMPONENTS[componentKey] ?? null
              : null;
          return (
            <div key={panel.id}>
              {HostComponent ? (
                <HostComponent
                  activeThreadId={activeThreadId}
                  activeViewId={activeViewId}
                  onCreateThread={onCreateThread}
                  onSelectThread={onSelectThread}
                  onSelectView={onSelectView}
                  panel={panel}
                  snapshot={snapshot}
                  threads={threads}
                  views={views}
                />
              ) : (
                <SidebarPanelContent panel={panel} />
              )}
              {index < contentPanels.length - 1 ? <SidebarSeparator /> : null}
            </div>
          );
        })}
      </SidebarContent>

      <SidebarFooter>
        {footerPanels.map((panel) => {
          const componentKey = panel.pluginId
            ? `${panel.pluginId}:${panel.render.component ?? ""}`
            : panel.render.component ?? "";
          const HostComponent =
            panel.render.kind === "host"
              ? SIDEBAR_HOST_COMPONENTS[componentKey] ?? null
              : null;
          return HostComponent ? (
            <HostComponent
              key={panel.id}
              activeThreadId={activeThreadId}
              activeViewId={activeViewId}
              onCreateThread={onCreateThread}
              onSelectThread={onSelectThread}
              onSelectView={onSelectView}
              panel={panel}
              snapshot={snapshot}
              threads={threads}
              views={views}
            />
          ) : (
            <SidebarPanelContent key={panel.id} panel={panel} />
          );
        })}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Settings" isActive={showSettings} onClick={onOpenSettings}>
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Get Help" disabled>
              <CircleHelp />
              <span>Get Help</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        {shouldShowRuntimeCard(snapshot) ? (
          <div className="px-2 pb-1 group-data-[collapsible=icon]:hidden">
            <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    snapshot?.runtimeStatus.state === "error"
                      ? "destructive"
                      : "secondary"
                  }
                >
                  {connectionState === "connecting"
                    ? "Connecting"
                    : snapshot?.runtimeStatus.state ?? "Offline"}
                </Badge>
                {!snapshot?.auth.available ? (
                  <Badge variant="outline">{snapshot?.auth.label ?? "Auth"}</Badge>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
