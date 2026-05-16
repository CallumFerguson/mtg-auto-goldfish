import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"
import { createPortal } from "react-dom"
import {
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  CircleOff,
  LayoutDashboard,
  LogIn,
  MoreVertical,
  Plus,
  Power,
  RefreshCw,
  ShieldAlert,
  Star,
  Trash2,
  UserRound,
  UsersRound,
  X,
  XCircle,
} from "lucide-react"
import { useNavigate } from "react-router-dom"

import { AccountMenu } from "@/components/AccountMenu"
import { Button } from "@/components/ui/button"
import { API_BASE_URL, apiFetch } from "@/lib/api"
import { readApiError } from "@/lib/api-error"
import type { AdminUser, AdminUsersResponse } from "@/lib/admin-types"
import { authClient, type AuthUser } from "@/lib/auth-client"
import {
  formatProviderLabel,
  getLlmModelPresetLabel,
  type AdminLlmModelPreset,
  type AdminLlmModelPresetsResponse,
  type LlmProvider,
  type ReasoningEffort,
} from "@/lib/llm-model-preset-types"
import type { AdminDashboardSectionId } from "@/lib/navigation"

type AdminDashboardProps = {
  activeSectionId: AdminDashboardSectionId | null
  adminOptionsEnabled: boolean
  isImpersonating: boolean
  onAdminOptionsEnabledChange: (isEnabled: boolean) => void
  onSessionChanged: () => Promise<void> | void
  onSignedOut: () => void
  onStopImpersonating: () => Promise<void> | void
  user: AuthUser
}

type AdminSection = {
  id: AdminDashboardSectionId
  label: string
  description: string
  path: string
  Icon: typeof UsersRound
}

const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    id: "users",
    label: "Users",
    description: "Accounts and access",
    path: "/admin/users",
    Icon: UsersRound,
  },
  {
    id: "model-presets",
    label: "Model presets",
    description: "Runtime LLM choices",
    path: "/admin/model-presets",
    Icon: BrainCircuit,
  },
]

const ADMIN_USER_ACTIONS_MENU_WIDTH = 208
const ADMIN_USER_ACTIONS_MENU_GAP = 6
const ADMIN_USER_ACTIONS_MENU_VIEWPORT_MARGIN = 8

type FloatingMenuPosition = {
  left: number
  maxHeight: number
  top: number
}

const REASONING_EFFORT_OPTIONS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]

export function AdminDashboardPage({
  activeSectionId,
  adminOptionsEnabled,
  isImpersonating,
  onAdminOptionsEnabledChange,
  onSessionChanged,
  onSignedOut,
  onStopImpersonating,
  user,
}: AdminDashboardProps) {
  const navigate = useNavigate()
  const activeSection = ADMIN_SECTIONS.find(
    (section) => section.id === activeSectionId
  )

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <AdminDashboardHeader
          adminOptionsEnabled={adminOptionsEnabled}
          isImpersonating={isImpersonating}
          navigate={navigate}
          onAdminOptionsEnabledChange={onAdminOptionsEnabledChange}
          onSignedOut={onSignedOut}
          onStopImpersonating={onStopImpersonating}
          user={user}
        />

        <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="hidden rounded-lg border border-border bg-card/70 p-2 lg:block">
            <AdminSectionNav
              activeSectionId={activeSectionId}
              navigate={navigate}
            />
          </aside>

          <div className="min-w-0 space-y-4">
            <div className="debug-scrollbar-neutral overflow-x-auto lg:hidden">
              <div className="flex min-w-max gap-2 rounded-lg border border-border bg-card/70 p-2">
                <AdminSectionNav
                  activeSectionId={activeSectionId}
                  compact
                  navigate={navigate}
                />
              </div>
            </div>

            {activeSection?.id === "users" ? (
              <AdminUsersSection
                currentUserId={user.id}
                onSessionChanged={onSessionChanged}
              />
            ) : activeSection?.id === "model-presets" ? (
              <AdminModelPresetsSection />
            ) : (
              <UnknownAdminSection />
            )}
          </div>
        </div>
      </div>
    </main>
  )
}

export function AdminAccessDeniedPage({
  adminOptionsEnabled,
  isImpersonating,
  onAdminOptionsEnabledChange,
  onSignedOut,
  onStopImpersonating,
  user,
}: Omit<
  AdminDashboardProps,
  "activeSectionId" | "onSessionChanged"
>) {
  const navigate = useNavigate()

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-3 border-b border-border pb-5">
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={() => navigate("/")}
          >
            <ArrowLeft data-icon="inline-start" />
            Decks
          </Button>
          <AccountMenu
            adminOptionsEnabled={adminOptionsEnabled}
            isImpersonating={isImpersonating}
            onAdminOptionsEnabledChange={onAdminOptionsEnabledChange}
            onSignedOut={onSignedOut}
            onStopImpersonating={onStopImpersonating}
            user={user}
          />
        </header>

        <section className="rounded-lg border border-border bg-card/70 px-5 py-8 shadow-2xl shadow-black/20">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-destructive/40 bg-destructive/10 text-destructive">
              <ShieldAlert className="size-5" aria-hidden="true" />
            </div>
            <div className="space-y-3">
              <div className="space-y-1">
                <h1 className="text-2xl font-semibold">
                  Admin access required
                </h1>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                  Your account does not have permission to view this dashboard.
                </p>
              </div>
              <Button type="button" onClick={() => navigate("/")}>
                <ArrowLeft data-icon="inline-start" />
                Back to decks
              </Button>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}

function AdminDashboardHeader({
  adminOptionsEnabled,
  isImpersonating,
  navigate,
  onAdminOptionsEnabledChange,
  onSignedOut,
  onStopImpersonating,
  user,
}: Omit<
  AdminDashboardProps,
  "activeSectionId" | "onSessionChanged"
> & {
  navigate: (path: string) => void
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-3">
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="w-fit"
          onClick={() => navigate("/")}
        >
          <ArrowLeft data-icon="inline-start" />
          Decks
        </Button>
        <div className="space-y-1">
          <p className="text-sm font-medium text-sky-300">MTG Auto Deck</p>
          <div className="flex items-center gap-2">
            <LayoutDashboard className="size-6 text-sky-300" aria-hidden />
            <h1 className="text-3xl font-semibold text-foreground sm:text-4xl">
              Admin dashboard
            </h1>
          </div>
        </div>
      </div>

      <AccountMenu
        adminOptionsEnabled={adminOptionsEnabled}
        isImpersonating={isImpersonating}
        onAdminOptionsEnabledChange={onAdminOptionsEnabledChange}
        onSignedOut={onSignedOut}
        onStopImpersonating={onStopImpersonating}
        user={user}
      />
    </header>
  )
}

function AdminSectionNav({
  activeSectionId,
  compact = false,
  navigate,
}: {
  activeSectionId: AdminDashboardSectionId | null
  compact?: boolean
  navigate: (path: string) => void
}) {
  return (
    <>
      {ADMIN_SECTIONS.map((section) => {
        const Icon = section.Icon
        const isActive = section.id === activeSectionId

        return (
          <button
            className={`flex min-w-44 items-center gap-3 rounded-md px-3 py-2 text-left transition-colors focus:bg-muted/45 focus:outline-none ${
              compact ? "shrink-0" : "w-full"
            } ${
              isActive
                ? "border border-sky-300/30 bg-accent text-foreground"
                : "border border-transparent text-muted-foreground hover:bg-muted/45 hover:text-foreground"
            }`}
            key={section.id}
            type="button"
            onClick={() => navigate(section.path)}
          >
            <Icon
              className={`size-4 shrink-0 ${
                isActive ? "text-sky-300" : "text-muted-foreground"
              }`}
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {section.label}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {section.description}
              </span>
            </span>
          </button>
        )
      })}
    </>
  )
}

function AdminUsersSection({
  currentUserId,
  onSessionChanged,
}: {
  currentUserId: string
  onSessionChanged: () => Promise<void> | void
}) {
  const navigate = useNavigate()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [totalLlmRunCostUsd, setTotalLlmRunCostUsd] = useState(0)
  const [recentLlmRunCostUsd, setRecentLlmRunCostUsd] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openUserMenuId, setOpenUserMenuId] = useState<string | null>(null)
  const [userToDelete, setUserToDelete] = useState<AdminUser | null>(null)
  const [deleteUserError, setDeleteUserError] = useState<string | null>(null)
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null)
  const [impersonateUserError, setImpersonateUserError] = useState<
    string | null
  >(null)
  const [impersonatingUserId, setImpersonatingUserId] = useState<string | null>(
    null
  )

  const loadUsers = useCallback(async () => {
    setIsLoading(true)
    setLoadError(null)
    setImpersonateUserError(null)

    try {
      const response = await apiFetch(`${API_BASE_URL}/admin/users`)

      if (!response.ok) {
        setLoadError(await readApiError(response, "Users could not be loaded."))
        return
      }

      const data = (await response.json()) as AdminUsersResponse
      setUsers(data.users)
      setTotal(data.total)
      setTotalLlmRunCostUsd(data.totalLlmRunCostUsd ?? 0)
      setRecentLlmRunCostUsd(data.recentLlmRunCostUsd ?? 0)
    } catch {
      setLoadError("Users could not be loaded.")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  async function handleDeleteUser() {
    if (!userToDelete) {
      return
    }

    setDeletingUserId(userToDelete.id)
    setDeleteUserError(null)

    try {
      const response = await apiFetch(
        `${API_BASE_URL}/admin/users/${encodeURIComponent(userToDelete.id)}`,
        {
          method: "DELETE",
        }
      )

      if (!response.ok) {
        setDeleteUserError(
          await readApiError(response, "User could not be deleted.")
        )
        return
      }

      setUsers((currentUsers) =>
        currentUsers.filter((user) => user.id !== userToDelete.id)
      )
      setTotal((currentTotal) => Math.max(0, currentTotal - 1))
      setTotalLlmRunCostUsd((currentCost) =>
        Math.max(0, currentCost - userToDelete.totalLlmRunCostUsd)
      )
      setRecentLlmRunCostUsd((currentCost) =>
        Math.max(0, currentCost - userToDelete.recentLlmRunCostUsd)
      )
      setUserToDelete(null)
    } catch {
      setDeleteUserError("User could not be deleted.")
    } finally {
      setDeletingUserId(null)
    }
  }

  async function handleImpersonateUser(user: AdminUser) {
    if (!canImpersonateUser(user, currentUserId)) {
      return
    }

    setImpersonatingUserId(user.id)
    setImpersonateUserError(null)

    try {
      const result = await authClient.admin.impersonateUser({
        userId: user.id,
      })

      if (result.error) {
        setImpersonateUserError(
          getAuthClientErrorMessage(
            result.error,
            `Could not impersonate ${user.email}.`
          )
        )
        return
      }

      await onSessionChanged()
      navigate("/")
    } catch {
      setImpersonateUserError(`Could not impersonate ${user.email}.`)
    } finally {
      setImpersonatingUserId(null)
    }
  }

  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card/70 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <UsersRound className="size-5 shrink-0 text-sky-300" aria-hidden />
            <h2 className="text-xl font-semibold">Users</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {isLoading
              ? "Loading accounts..."
              : `${total} ${total === 1 ? "account" : "accounts"}`}
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <AdminCostSummary label="Last hour">
              {formatUsdCost(recentLlmRunCostUsd)}
            </AdminCostSummary>
            <AdminCostSummary label="All time">
              {formatUsdCost(totalLlmRunCostUsd)}
            </AdminCostSummary>
          </dl>
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadUsers()}
            disabled={isLoading}
          >
            <RefreshCw
              data-icon="inline-start"
              className={isLoading ? "animate-spin" : undefined}
            />
            Refresh
          </Button>
        </div>
      </div>

      {impersonateUserError ? (
        <p
          className="rounded-lg border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {impersonateUserError}
        </p>
      ) : null}

      {isLoading ? (
        <AdminPanelMessage>Loading users...</AdminPanelMessage>
      ) : loadError ? (
        <div className="flex flex-col gap-3 rounded-lg border border-destructive/35 bg-destructive/10 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-destructive" role="alert">
            {loadError}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadUsers()}
          >
            Try again
          </Button>
        </div>
      ) : users.length > 0 ? (
        <>
          <div className="debug-scrollbar-neutral hidden overflow-x-auto rounded-lg border border-border bg-card/70 md:block">
            <table className="w-full min-w-[56rem] border-collapse text-sm">
              <thead className="border-b border-border bg-muted/25 text-xs text-muted-foreground">
                <tr>
                  <TableHeader>Account</TableHeader>
                  <TableHeader>Verified</TableHeader>
                  <TableHeader>Role</TableHeader>
                  <TableHeader>Last hour</TableHeader>
                  <TableHeader>Total cost</TableHeader>
                  <TableHeader>
                    <span className="sr-only">Actions</span>
                  </TableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.map((user) => (
                  <tr
                    className="transition-colors hover:bg-muted/25"
                    key={user.id}
                  >
                    <TableCell>
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">
                          {user.email}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {getDisplayName(user)}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <VerificationBadge isVerified={user.emailVerified} />
                    </TableCell>
                    <TableCell>
                      <RoleBadge role={user.role} />
                    </TableCell>
                    <TableCell>
                      <CostText>
                        {formatUsdCost(user.recentLlmRunCostUsd)}
                      </CostText>
                    </TableCell>
                    <TableCell>
                      <CostText>
                        {formatUsdCost(user.totalLlmRunCostUsd)}
                      </CostText>
                    </TableCell>
                    <TableCell>
                      <AdminUserActionsMenu
                        currentUserId={currentUserId}
                        deletingUserId={deletingUserId}
                        impersonatingUserId={impersonatingUserId}
                        menuId={`desktop-${user.id}`}
                        openUserMenuId={openUserMenuId}
                        setOpenUserMenuId={setOpenUserMenuId}
                        user={user}
                        onDeleteUser={(selectedUser) => {
                          setDeleteUserError(null)
                          setUserToDelete(selectedUser)
                        }}
                        onImpersonateUser={(selectedUser) =>
                          void handleImpersonateUser(selectedUser)
                        }
                      />
                    </TableCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="grid gap-3 md:hidden">
            {users.map((user) => (
              <li
                className="rounded-lg border border-border bg-card/70 p-4"
                key={user.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium break-words">
                      {user.email}
                    </p>
                    <p className="text-xs break-words text-muted-foreground">
                      {getDisplayName(user)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <RoleBadge role={user.role} />
                    <AdminUserActionsMenu
                      currentUserId={currentUserId}
                      deletingUserId={deletingUserId}
                      impersonatingUserId={impersonatingUserId}
                      menuId={`mobile-${user.id}`}
                      openUserMenuId={openUserMenuId}
                      setOpenUserMenuId={setOpenUserMenuId}
                      user={user}
                      onDeleteUser={(selectedUser) => {
                        setDeleteUserError(null)
                        setUserToDelete(selectedUser)
                      }}
                      onImpersonateUser={(selectedUser) =>
                        void handleImpersonateUser(selectedUser)
                      }
                    />
                  </div>
                </div>

                <dl className="mt-4 grid gap-3 text-sm">
                  <AdminUserDetail label="Verified">
                    <VerificationBadge isVerified={user.emailVerified} />
                  </AdminUserDetail>
                  <AdminUserDetail label="Last hour">
                    <CostText>
                      {formatUsdCost(user.recentLlmRunCostUsd)}
                    </CostText>
                  </AdminUserDetail>
                  <AdminUserDetail label="Total cost">
                    <CostText>
                      {formatUsdCost(user.totalLlmRunCostUsd)}
                    </CostText>
                  </AdminUserDetail>
                </dl>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <AdminPanelMessage>No users found.</AdminPanelMessage>
      )}

      {userToDelete ? (
        <DeleteAdminUserModal
          error={deleteUserError}
          isDeleting={deletingUserId === userToDelete.id}
          user={userToDelete}
          onClose={() => {
            setUserToDelete(null)
            setDeleteUserError(null)
          }}
          onConfirm={() => void handleDeleteUser()}
        />
      ) : null}
    </section>
  )
}

function AdminModelPresetsSection() {
  const [presets, setPresets] = useState<AdminLlmModelPreset[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [workingPresetId, setWorkingPresetId] = useState<string | null>(null)
  const [presetToDelete, setPresetToDelete] =
    useState<AdminLlmModelPreset | null>(null)
  const [deletingPresetId, setDeletingPresetId] = useState<string | null>(null)
  const [deletePresetError, setDeletePresetError] = useState<string | null>(
    null
  )
  const [form, setForm] = useState({
    provider: "openai" as LlmProvider,
    model: "",
    reasoningEffort: "medium" as ReasoningEffort,
    openrouterModelProvider: "",
    inputTokenCostUsdPerMillion: "",
    cachedInputTokenCostUsdPerMillion: "",
    outputTokenCostUsdPerMillion: "",
    isEnabled: true,
    isDefault: false,
  })

  const loadPresets = useCallback(async () => {
    setIsLoading(true)
    setLoadError(null)

    try {
      const response = await apiFetch(
        `${API_BASE_URL}/admin/llm-model-presets`
      )

      if (!response.ok) {
        setLoadError(
          await readApiError(response, "Model presets could not be loaded.")
        )
        return
      }

      const data = (await response.json()) as AdminLlmModelPresetsResponse
      setPresets(data.presets)
    } catch {
      setLoadError("Model presets could not be loaded.")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadPresets()
  }, [loadPresets])

  async function handleCreatePreset() {
    const model = form.model.trim()

    if (!model) {
      setActionError("Model is required.")
      return
    }

    setIsCreating(true)
    setActionError(null)

    try {
      const response = await apiFetch(`${API_BASE_URL}/admin/llm-model-presets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: form.provider,
          model,
          reasoningEffort: form.reasoningEffort,
          openrouterModelProvider:
            form.provider === "openrouter"
              ? form.openrouterModelProvider.trim() || null
              : null,
          inputTokenCostUsdPerMillion: parseOptionalCost(
            form.inputTokenCostUsdPerMillion
          ),
          cachedInputTokenCostUsdPerMillion: parseOptionalCost(
            form.cachedInputTokenCostUsdPerMillion
          ),
          outputTokenCostUsdPerMillion: parseOptionalCost(
            form.outputTokenCostUsdPerMillion
          ),
          isEnabled: form.isEnabled,
          isDefault: form.isDefault,
        }),
      })

      if (!response.ok) {
        setActionError(
          await readApiError(response, "Model preset could not be created.")
        )
        return
      }

      await response.json()
      setForm((currentForm) => ({
        ...currentForm,
        model: "",
        openrouterModelProvider: "",
        inputTokenCostUsdPerMillion: "",
        cachedInputTokenCostUsdPerMillion: "",
        outputTokenCostUsdPerMillion: "",
        isDefault: false,
      }))
      await loadPresets()
    } catch {
      setActionError("Model preset could not be created.")
    } finally {
      setIsCreating(false)
    }
  }

  async function updatePresetAction(
    presetId: string,
    action: () => Promise<Response>,
    fallbackMessage: string
  ) {
    setWorkingPresetId(presetId)
    setActionError(null)

    try {
      const response = await action()

      if (!response.ok) {
        setActionError(await readApiError(response, fallbackMessage))
        return
      }

      await loadPresets()
    } catch {
      setActionError(fallbackMessage)
    } finally {
      setWorkingPresetId(null)
    }
  }

  async function handleDeletePreset() {
    if (!presetToDelete || !presetToDelete.canDelete) {
      return
    }

    setDeletingPresetId(presetToDelete.id)
    setDeletePresetError(null)

    try {
      const response = await apiFetch(
        `${API_BASE_URL}/admin/llm-model-presets/${presetToDelete.id}`,
        {
          method: "DELETE",
        }
      )

      if (!response.ok) {
        setDeletePresetError(
          await readApiError(response, "Model preset could not be deleted.")
        )
        return
      }

      setPresetToDelete(null)
      await loadPresets()
    } catch {
      setDeletePresetError("Model preset could not be deleted.")
    } finally {
      setDeletingPresetId(null)
    }
  }

  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/70 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <BrainCircuit
              className="size-5 shrink-0 text-sky-300"
              aria-hidden
            />
            <h2 className="text-xl font-semibold">Model presets</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {isLoading
              ? "Loading presets..."
              : `${presets.length} ${
                  presets.length === 1 ? "preset" : "presets"
                }`}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void loadPresets()}
          disabled={isLoading}
        >
          <RefreshCw
            data-icon="inline-start"
            className={isLoading ? "animate-spin" : undefined}
          />
          Refresh
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-card/70 p-4">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleCreatePreset()
          }}
        >
          <div className="flex items-center gap-2">
            <Plus className="size-4 text-sky-300" aria-hidden />
            <h3 className="text-sm font-semibold">Add preset</h3>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <AdminFormField label="Provider">
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-3 focus:ring-ring/30"
                value={form.provider}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    provider: event.target.value as LlmProvider,
                  }))
                }
              >
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="llamacpp">llama.cpp</option>
              </select>
            </AdminFormField>
            <AdminFormField label="Model">
              <input
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30"
                value={form.model}
                placeholder="gpt-5.4-nano"
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    model: event.target.value,
                  }))
                }
              />
            </AdminFormField>
            <AdminFormField label="Reasoning">
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-3 focus:ring-ring/30"
                value={form.reasoningEffort}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    reasoningEffort: event.target.value as ReasoningEffort,
                  }))
                }
              >
                {REASONING_EFFORT_OPTIONS.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </AdminFormField>
            <AdminFormField label="OpenRouter provider">
              <input
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30 disabled:opacity-50"
                value={form.openrouterModelProvider}
                placeholder="openai"
                disabled={form.provider !== "openrouter"}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    openrouterModelProvider: event.target.value,
                  }))
                }
              />
            </AdminFormField>
            <AdminFormField label="Input $/M">
              <CostInput
                value={form.inputTokenCostUsdPerMillion}
                onChange={(value) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    inputTokenCostUsdPerMillion: value,
                  }))
                }
              />
            </AdminFormField>
            <AdminFormField label="Cached input $/M">
              <CostInput
                value={form.cachedInputTokenCostUsdPerMillion}
                onChange={(value) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    cachedInputTokenCostUsdPerMillion: value,
                  }))
                }
              />
            </AdminFormField>
            <AdminFormField label="Output $/M">
              <CostInput
                value={form.outputTokenCostUsdPerMillion}
                onChange={(value) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    outputTokenCostUsdPerMillion: value,
                  }))
                }
              />
            </AdminFormField>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-background/35 px-3 text-sm">
                <input
                  className="size-4 accent-sky-300"
                  type="checkbox"
                  checked={form.isEnabled}
                  onChange={(event) =>
                    setForm((currentForm) => ({
                      ...currentForm,
                      isEnabled: event.target.checked,
                      isDefault:
                        event.target.checked && currentForm.isDefault,
                    }))
                  }
                />
                Enabled
              </label>
              <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-background/35 px-3 text-sm">
                <input
                  className="size-4 accent-sky-300"
                  type="checkbox"
                  checked={form.isDefault}
                  disabled={!form.isEnabled}
                  onChange={(event) =>
                    setForm((currentForm) => ({
                      ...currentForm,
                      isDefault: event.target.checked,
                    }))
                  }
                />
                Default
              </label>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {actionError ? (
              <p
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {actionError}
              </p>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={isCreating}>
              <Plus data-icon="inline-start" />
              {isCreating ? "Adding..." : "Add preset"}
            </Button>
          </div>
        </form>
      </div>

      {isLoading ? (
        <AdminPanelMessage>Loading model presets...</AdminPanelMessage>
      ) : loadError ? (
        <div className="flex flex-col gap-3 rounded-lg border border-destructive/35 bg-destructive/10 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-destructive" role="alert">
            {loadError}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadPresets()}
          >
            Try again
          </Button>
        </div>
      ) : presets.length > 0 ? (
        <div className="rounded-lg border border-border bg-card/70">
          <table className="w-full table-fixed border-collapse text-xs sm:text-sm">
            <colgroup>
              <col className="w-[28%]" />
              <col className="w-[14%]" />
              <col className="w-[16%]" />
              <col className="w-[22%]" />
              <col className="w-[12%]" />
              <col className="w-[8%]" />
            </colgroup>
            <thead className="border-b border-border bg-muted/25 text-xs text-muted-foreground">
              <tr>
                <TableHeader>Preset</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Default</TableHeader>
                <TableHeader>Costs</TableHeader>
                <TableHeader>Refs</TableHeader>
                <TableHeader>
                  <span className="sr-only">Actions</span>
                </TableHeader>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {presets.map((preset) => (
                <tr className="transition-colors hover:bg-muted/25" key={preset.id}>
                  <TableCell>
                    <div className="min-w-0">
                      <p className="break-words font-medium text-foreground">
                        {getLlmModelPresetLabel(preset)}
                      </p>
                      <p className="break-words text-xs text-muted-foreground">
                        {formatProviderLabel(preset.provider)}
                        {preset.openrouterModelProvider
                          ? ` via ${preset.openrouterModelProvider}`
                          : ""}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      aria-pressed={preset.isEnabled}
                      aria-label={
                        preset.isEnabled
                          ? "Disable model preset"
                          : "Enable model preset"
                      }
                      title={
                        preset.isEnabled
                          ? "Disable model preset"
                          : "Enable model preset"
                      }
                      className={
                        preset.isEnabled
                          ? "w-full min-w-0 border-emerald-300/35 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/15 hover:text-emerald-100"
                          : "w-full min-w-0 border-border bg-muted/35 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      }
                      disabled={workingPresetId === preset.id}
                      onClick={() =>
                        void updatePresetAction(
                          preset.id,
                          () =>
                            apiFetch(
                              `${API_BASE_URL}/admin/llm-model-presets/${preset.id}/enabled`,
                              {
                                method: "PATCH",
                                headers: {
                                  "Content-Type": "application/json",
                                },
                                body: JSON.stringify({
                                  isEnabled: !preset.isEnabled,
                                }),
                              }
                            ),
                          "Model preset could not be updated."
                        )
                      }
                    >
                      {preset.isEnabled ? <Power /> : <CircleOff />}
                      <span className="hidden xl:inline">
                        {preset.isEnabled ? "Enabled" : "Disabled"}
                      </span>
                    </Button>
                  </TableCell>
                  <TableCell>
                    {preset.isDefault ? (
                      <StatusBadge
                        className="border-sky-300/35 bg-sky-400/10 text-sky-200"
                        icon={<Star className="size-3.5" aria-hidden />}
                      >
                        Default
                      </StatusBadge>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className="w-full min-w-0"
                        aria-label="Set default model preset"
                        title={
                          preset.isEnabled
                            ? "Set default model preset"
                            : "Enable preset before making it default"
                        }
                        disabled={
                          workingPresetId === preset.id || !preset.isEnabled
                        }
                        onClick={() =>
                          void updatePresetAction(
                            preset.id,
                            () =>
                              apiFetch(
                                `${API_BASE_URL}/admin/llm-model-presets/default`,
                                {
                                  method: "PUT",
                                  headers: {
                                    "Content-Type": "application/json",
                                  },
                                  body: JSON.stringify({
                                    presetId: preset.id,
                                  }),
                                }
                              ),
                            "Default model preset could not be changed."
                          )
                        }
                      >
                        <Star data-icon="inline-start" />
                        <span className="hidden xl:inline">Make default</span>
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    <CompactMetricList
                      items={[
                        ["in", formatOptionalCost(preset.inputTokenCostUsdPerMillion)],
                        [
                          "cached",
                          formatOptionalCost(
                            preset.cachedInputTokenCostUsdPerMillion
                          ),
                        ],
                        [
                          "out",
                          formatOptionalCost(preset.outputTokenCostUsdPerMillion),
                        ],
                      ]}
                    />
                  </TableCell>
                  <TableCell>
                    <CompactMetricList
                      items={[
                        ["sims", String(preset.simulationReferenceCount)],
                        ["runs", String(preset.llmRunReferenceCount)],
                        ["evals", String(preset.evaluationReferenceCount)],
                      ]}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon-sm"
                        aria-label="Delete model preset"
                        disabled={workingPresetId === preset.id}
                        title="Delete preset"
                        onClick={() => {
                          setPresetToDelete(preset)
                          setDeletePresetError(null)
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <AdminPanelMessage>No model presets found.</AdminPanelMessage>
      )}

      {presetToDelete ? (
        <DeleteLlmModelPresetModal
          error={deletePresetError}
          isDeleting={deletingPresetId === presetToDelete.id}
          preset={presetToDelete}
          onClose={() => {
            setPresetToDelete(null)
            setDeletePresetError(null)
          }}
          onConfirm={() => void handleDeletePreset()}
        />
      ) : null}
    </section>
  )
}

function UnknownAdminSection() {
  const navigate = useNavigate()

  return (
    <section className="rounded-lg border border-border bg-card/70 px-5 py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/35 text-muted-foreground">
          <ShieldAlert className="size-5" aria-hidden="true" />
        </div>
        <div className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold">Admin section not found</h2>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              This admin section is not available.
            </p>
          </div>
          <Button type="button" onClick={() => navigate("/admin/users")}>
            <UsersRound data-icon="inline-start" />
            Users
          </Button>
        </div>
      </div>
    </section>
  )
}

function DeleteLlmModelPresetModal({
  error,
  isDeleting,
  onClose,
  onConfirm,
  preset,
}: {
  error: string | null
  isDeleting: boolean
  onClose: () => void
  onConfirm: () => void
  preset: AdminLlmModelPreset
}) {
  const canDelete = preset.canDelete
  const title = canDelete ? "Delete model preset" : "Cannot delete preset"
  const closeIfAllowed = () => {
    if (!isDeleting) {
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onMouseDown={closeIfAllowed}
    >
      <section
        aria-labelledby="delete-model-preset-title"
        className="w-full max-w-lg rounded-lg border border-border bg-card shadow-2xl shadow-black/40"
        role="alertdialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex items-start gap-3">
            <div
              className={
                canDelete
                  ? "flex size-9 shrink-0 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 text-destructive"
                  : "flex size-9 shrink-0 items-center justify-center rounded-lg border border-amber-300/35 bg-amber-400/10 text-amber-200"
              }
            >
              {canDelete ? (
                <Trash2 className="size-4" aria-hidden />
              ) : (
                <ShieldAlert className="size-4" aria-hidden />
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <h2 id="delete-model-preset-title" className="text-xl font-semibold">
                {title}
              </h2>
              <p className="text-sm break-words text-muted-foreground">
                {getLlmModelPresetLabel(preset)}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            title="Close"
            disabled={isDeleting}
            onClick={onClose}
          >
            <X />
          </Button>
        </header>

        <div className="grid gap-4 px-5 py-5">
          {canDelete ? (
            <p className="text-sm leading-6 text-muted-foreground">
              This preset has no references and can be permanently deleted.
              Disable presets instead when you want to retire a model that has
              already been used.
            </p>
          ) : (
            <>
              <p className="text-sm leading-6 text-muted-foreground">
                This preset is already referenced, so it cannot be deleted.
                Disable it instead to keep historical simulations and runs
                intact while preventing future use.
              </p>
              <div className="rounded-md border border-border bg-background/35 px-3 py-2">
                <CompactMetricList
                  items={[
                    ["sims", String(preset.simulationReferenceCount)],
                    ["runs", String(preset.llmRunReferenceCount)],
                    ["evals", String(preset.evaluationReferenceCount)],
                  ]}
                />
              </div>
            </>
          )}

          {error ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isDeleting}
              onClick={onClose}
            >
              {canDelete ? "Cancel" : "Close"}
            </Button>
            {canDelete ? (
              <Button
                type="button"
                variant="destructive"
                disabled={isDeleting}
                onClick={onConfirm}
              >
                <Trash2 data-icon="inline-start" />
                {isDeleting ? "Deleting..." : "Delete preset"}
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  )
}

function AdminUserActionsMenu({
  currentUserId,
  deletingUserId,
  impersonatingUserId,
  menuId,
  onDeleteUser,
  onImpersonateUser,
  openUserMenuId,
  setOpenUserMenuId,
  user,
}: {
  currentUserId: string
  deletingUserId: string | null
  impersonatingUserId: string | null
  menuId: string
  onDeleteUser: (user: AdminUser) => void
  onImpersonateUser: (user: AdminUser) => void
  openUserMenuId: string | null
  setOpenUserMenuId: Dispatch<SetStateAction<string | null>>
  user: AdminUser
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPosition, setMenuPosition] = useState<FloatingMenuPosition | null>(
    null
  )
  const isCurrentUser = user.id === currentUserId
  const isDeleting = deletingUserId === user.id
  const isImpersonatingUser = impersonatingUserId === user.id
  const isOpen = openUserMenuId === menuId
  const canImpersonate = canImpersonateUser(user, currentUserId)

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current

    if (!trigger || trigger.getClientRects().length === 0) {
      setOpenUserMenuId(null)
      return
    }

    const triggerRect = trigger.getBoundingClientRect()
    const menuWidth =
      menuRef.current?.offsetWidth ?? ADMIN_USER_ACTIONS_MENU_WIDTH
    const menuHeight = menuRef.current?.offsetHeight ?? 0
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const minimumLeft = ADMIN_USER_ACTIONS_MENU_VIEWPORT_MARGIN
    const maximumLeft = Math.max(
      minimumLeft,
      viewportWidth - menuWidth - ADMIN_USER_ACTIONS_MENU_VIEWPORT_MARGIN
    )
    const left = Math.min(
      Math.max(triggerRect.right - menuWidth, minimumLeft),
      maximumLeft
    )
    const belowTop = triggerRect.bottom + ADMIN_USER_ACTIONS_MENU_GAP
    const aboveTop = triggerRect.top - menuHeight - ADMIN_USER_ACTIONS_MENU_GAP
    const shouldOpenBelow =
      belowTop + menuHeight <=
      viewportHeight - ADMIN_USER_ACTIONS_MENU_VIEWPORT_MARGIN
    const preferredTop = shouldOpenBelow ? belowTop : aboveTop
    const maximumTop = Math.max(
      ADMIN_USER_ACTIONS_MENU_VIEWPORT_MARGIN,
      viewportHeight - menuHeight - ADMIN_USER_ACTIONS_MENU_VIEWPORT_MARGIN
    )
    const top = Math.min(
      Math.max(preferredTop, ADMIN_USER_ACTIONS_MENU_VIEWPORT_MARGIN),
      maximumTop
    )
    const maxHeight = Math.max(
      80,
      Math.floor(viewportHeight - top - ADMIN_USER_ACTIONS_MENU_VIEWPORT_MARGIN)
    )
    const nextPosition = {
      left: Math.round(left),
      maxHeight,
      top: Math.round(top),
    }

    setMenuPosition((currentPosition) =>
      currentPosition?.left === nextPosition.left &&
      currentPosition.maxHeight === nextPosition.maxHeight &&
      currentPosition.top === nextPosition.top
        ? currentPosition
        : nextPosition
    )
  }, [setOpenUserMenuId])

  useLayoutEffect(() => {
    if (isOpen) {
      updateMenuPosition()
    }
  }, [isOpen, updateMenuPosition])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    window.addEventListener("resize", updateMenuPosition)
    window.addEventListener("scroll", updateMenuPosition, true)

    return () => {
      window.removeEventListener("resize", updateMenuPosition)
      window.removeEventListener("scroll", updateMenuPosition, true)
    }
  }, [isOpen, updateMenuPosition])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenUserMenuId(null)
      }
    }

    window.addEventListener("keydown", handleKeyDown)

    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isOpen, setOpenUserMenuId])

  const menuStyle: CSSProperties = menuPosition
    ? {
        left: menuPosition.left,
        maxHeight: menuPosition.maxHeight,
        top: menuPosition.top,
      }
    : {
        left: 0,
        top: 0,
        visibility: "hidden",
      }

  return (
    <div className="flex justify-end">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Open actions for ${user.email}`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        title="User actions"
        disabled={isDeleting || isImpersonatingUser}
        onClick={() =>
          setOpenUserMenuId((currentUserMenuId) =>
            currentUserMenuId === menuId ? null : menuId
          )
        }
      >
        <MoreVertical />
      </Button>

      {isOpen && typeof document !== "undefined"
        ? createPortal(
            <>
              <button
                className="fixed inset-0 z-10 cursor-default"
                type="button"
                aria-label="Close user actions"
                onClick={() => setOpenUserMenuId(null)}
              />
              <div
                ref={menuRef}
                className="fixed z-20 w-52 max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-2xl shadow-black/40"
                role="menu"
                style={menuStyle}
              >
                {isCurrentUser ? (
                  <button
                    className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground opacity-70"
                    type="button"
                    role="menuitem"
                    disabled
                  >
                    <UserRound data-icon="inline-start" />
                    Current account
                  </button>
                ) : (
                  <>
                    {canImpersonate ? (
                      <button
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-sky-100 transition-colors hover:bg-sky-400/10 hover:text-sky-100 focus:bg-sky-400/10 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                        type="button"
                        role="menuitem"
                        disabled={isDeleting || isImpersonatingUser}
                        onClick={() => {
                          setOpenUserMenuId(null)
                          onImpersonateUser(user)
                        }}
                      >
                        <LogIn data-icon="inline-start" />
                        {isImpersonatingUser
                          ? "Impersonating..."
                          : "Impersonate"}
                      </button>
                    ) : null}
                    <button
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                      type="button"
                      role="menuitem"
                      disabled={isDeleting || isImpersonatingUser}
                      onClick={() => {
                        setOpenUserMenuId(null)
                        onDeleteUser(user)
                      }}
                    >
                      <Trash2 data-icon="inline-start" />
                      Delete user
                    </button>
                  </>
                )}
              </div>
            </>,
            document.body
          )
        : null}
    </div>
  )
}

function DeleteAdminUserModal({
  error,
  isDeleting,
  onClose,
  onConfirm,
  user,
}: {
  error: string | null
  isDeleting: boolean
  onClose: () => void
  onConfirm: () => void
  user: AdminUser
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onMouseDown={isDeleting ? undefined : onClose}
    >
      <section
        aria-labelledby="delete-user-title"
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-2xl shadow-black/40"
        role="alertdialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 text-destructive">
                <Trash2 className="size-4" aria-hidden="true" />
              </div>
              <h2 id="delete-user-title" className="text-xl font-semibold">
                Delete user
              </h2>
            </div>
            <p className="text-sm break-words text-muted-foreground">
              This will permanently delete {user.email}.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            disabled={isDeleting}
          >
            <X />
          </Button>
        </header>

        <div className="grid gap-4 px-5 py-5">
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm leading-6 text-destructive">
            Their decks, simulations, runs, saved seeds, and starting hands will
            be permanently removed.
          </p>

          {error ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={onConfirm}
              disabled={isDeleting}
            >
              <Trash2 data-icon="inline-start" />
              {isDeleting ? "Deleting..." : "Delete user"}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}

function AdminFormField({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      <span>{label}</span>
      {children}
    </label>
  )
}

function CostInput({
  onChange,
  value,
}: {
  onChange: (value: string) => void
  value: string
}) {
  return (
    <input
      className="no-number-spinner h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30"
      type="number"
      min="0"
      step="0.000001"
      value={value}
      placeholder="optional"
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

function CompactMetricList({
  items,
}: {
  items: readonly (readonly [label: string, value: string])[]
}) {
  return (
    <dl className="grid gap-0.5 text-xs text-muted-foreground">
      {items.map(([label, value]) => (
        <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-1" key={label}>
          <dt>{label}</dt>
          <dd className="min-w-0 break-words text-foreground/85">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function parseOptionalCost(value: string) {
  const trimmedValue = value.trim()

  if (!trimmedValue) {
    return null
  }

  const parsedValue = Number(trimmedValue)

  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : null
}

function formatOptionalCost(value: number | null) {
  return value === null ? "n/a" : `$${value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")}`
}

function formatUsdCost(value: number) {
  return `$${(Number.isFinite(value) ? value : 0).toFixed(2)}`
}

function AdminCostSummary({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm font-semibold text-foreground">
        {children}
      </dd>
    </div>
  )
}

function CostText({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-sm font-medium text-foreground">
      {children}
    </span>
  )
}

function TableHeader({ children }: { children: ReactNode }) {
  return (
    <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
      {children}
    </th>
  )
}

function TableCell({ children }: { children: ReactNode }) {
  return <td className="px-4 py-3 align-middle">{children}</td>
}

function AdminPanelMessage({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card/70 px-4 py-8 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function AdminUserDetail({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  )
}

function VerificationBadge({ isVerified }: { isVerified: boolean }) {
  return isVerified ? (
    <StatusBadge
      className="border-emerald-300/35 bg-emerald-400/10 text-emerald-200"
      icon={<CheckCircle2 className="size-3.5" aria-hidden="true" />}
    >
      Verified
    </StatusBadge>
  ) : (
    <StatusBadge
      className="border-amber-300/35 bg-amber-400/10 text-amber-200"
      icon={<XCircle className="size-3.5" aria-hidden="true" />}
    >
      Unverified
    </StatusBadge>
  )
}

function RoleBadge({ role }: { role: string | null }) {
  const roleLabel = getRoleLabel(role)
  const isAdmin = isAdminRole(role)

  return (
    <StatusBadge
      className={
        isAdmin
          ? "border-sky-300/35 bg-sky-400/10 text-sky-200"
          : "border-border bg-muted/35 text-muted-foreground"
      }
      icon={<UserRound className="size-3.5" aria-hidden="true" />}
    >
      {roleLabel}
    </StatusBadge>
  )
}

function StatusBadge({
  children,
  className,
  icon,
}: {
  children: ReactNode
  className: string
  icon: ReactNode
}) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${className}`}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  )
}

function getDisplayName(user: AdminUser) {
  return user.name && user.name !== user.email ? user.name : user.id
}

function getRoleLabel(role: string | null) {
  return role?.trim() || "user"
}

function isAdminRole(role: string | null) {
  return getRoleLabel(role)
    .split(",")
    .map((rolePart) => rolePart.trim().toLowerCase())
    .includes("admin")
}

function canImpersonateUser(user: AdminUser, currentUserId: string) {
  return user.id !== currentUserId && !isAdminRole(user.role)
}

function getAuthClientErrorMessage(error: unknown, fallbackMessage: string) {
  if (!error || typeof error !== "object") {
    return fallbackMessage
  }

  const message = (error as Record<string, unknown>).message

  return typeof message === "string" && message.trim()
    ? message
    : fallbackMessage
}
