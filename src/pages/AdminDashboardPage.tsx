import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"
import {
  ArrowLeft,
  CheckCircle2,
  LayoutDashboard,
  MoreVertical,
  RefreshCw,
  ShieldAlert,
  Trash2,
  UserRound,
  UsersRound,
  X,
  XCircle,
} from "lucide-react"

import { AccountMenu } from "@/components/AccountMenu"
import { Button } from "@/components/ui/button"
import { API_BASE_URL, apiFetch } from "@/lib/api"
import { readApiError } from "@/lib/api-error"
import type { AdminUser, AdminUsersResponse } from "@/lib/admin-types"
import type { AuthUser } from "@/lib/auth-client"
import { navigateTo, type AdminDashboardSectionId } from "@/lib/navigation"

type AdminDashboardProps = {
  activeSectionId: AdminDashboardSectionId | null
  adminOptionsEnabled: boolean
  onAdminOptionsEnabledChange: (isEnabled: boolean) => void
  onSignedOut: () => void
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
]

export function AdminDashboardPage({
  activeSectionId,
  adminOptionsEnabled,
  onAdminOptionsEnabledChange,
  onSignedOut,
  user,
}: AdminDashboardProps) {
  const activeSection = ADMIN_SECTIONS.find(
    (section) => section.id === activeSectionId
  )

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <AdminDashboardHeader
          adminOptionsEnabled={adminOptionsEnabled}
          onAdminOptionsEnabledChange={onAdminOptionsEnabledChange}
          onSignedOut={onSignedOut}
          user={user}
        />

        <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="hidden rounded-lg border border-border bg-card/70 p-2 lg:block">
            <AdminSectionNav activeSectionId={activeSectionId} />
          </aside>

          <div className="min-w-0 space-y-4">
            <div className="debug-scrollbar-neutral overflow-x-auto lg:hidden">
              <div className="flex min-w-max gap-2 rounded-lg border border-border bg-card/70 p-2">
                <AdminSectionNav activeSectionId={activeSectionId} compact />
              </div>
            </div>

            {activeSection?.id === "users" ? (
              <AdminUsersSection currentUserId={user.id} />
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
  onAdminOptionsEnabledChange,
  onSignedOut,
  user,
}: Omit<AdminDashboardProps, "activeSectionId">) {
  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-3 border-b border-border pb-5">
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={() => navigateTo("/")}
          >
            <ArrowLeft data-icon="inline-start" />
            Decks
          </Button>
          <AccountMenu
            adminOptionsEnabled={adminOptionsEnabled}
            onAdminOptionsEnabledChange={onAdminOptionsEnabledChange}
            onSignedOut={onSignedOut}
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
              <Button type="button" onClick={() => navigateTo("/")}>
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
  onAdminOptionsEnabledChange,
  onSignedOut,
  user,
}: Omit<AdminDashboardProps, "activeSectionId">) {
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-3">
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="w-fit"
          onClick={() => navigateTo("/")}
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
        onAdminOptionsEnabledChange={onAdminOptionsEnabledChange}
        onSignedOut={onSignedOut}
        user={user}
      />
    </header>
  )
}

function AdminSectionNav({
  activeSectionId,
  compact = false,
}: {
  activeSectionId: AdminDashboardSectionId | null
  compact?: boolean
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
            onClick={() => navigateTo(section.path)}
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

function AdminUsersSection({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openUserMenuId, setOpenUserMenuId] = useState<string | null>(null)
  const [userToDelete, setUserToDelete] = useState<AdminUser | null>(null)
  const [deleteUserError, setDeleteUserError] = useState<string | null>(null)
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null)

  const loadUsers = useCallback(async () => {
    setIsLoading(true)
    setLoadError(null)

    try {
      const response = await apiFetch(`${API_BASE_URL}/admin/users`)

      if (!response.ok) {
        setLoadError(await readApiError(response, "Users could not be loaded."))
        return
      }

      const data = (await response.json()) as AdminUsersResponse
      setUsers(data.users)
      setTotal(data.total)
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
      setUserToDelete(null)
    } catch {
      setDeleteUserError("User could not be deleted.")
    } finally {
      setDeletingUserId(null)
    }
  }

  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/70 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
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
                  <TableHeader>Created</TableHeader>
                  <TableHeader>Updated</TableHeader>
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
                    <TableCell>{formatDateTime(user.createdAt)}</TableCell>
                    <TableCell>{formatDateTime(user.updatedAt)}</TableCell>
                    <TableCell>
                      <AdminUserActionsMenu
                        currentUserId={currentUserId}
                        deletingUserId={deletingUserId}
                        openUserMenuId={openUserMenuId}
                        setOpenUserMenuId={setOpenUserMenuId}
                        user={user}
                        onDeleteUser={(selectedUser) => {
                          setDeleteUserError(null)
                          setUserToDelete(selectedUser)
                        }}
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
                      openUserMenuId={openUserMenuId}
                      setOpenUserMenuId={setOpenUserMenuId}
                      user={user}
                      onDeleteUser={(selectedUser) => {
                        setDeleteUserError(null)
                        setUserToDelete(selectedUser)
                      }}
                    />
                  </div>
                </div>

                <dl className="mt-4 grid gap-3 text-sm">
                  <AdminUserDetail label="Verified">
                    <VerificationBadge isVerified={user.emailVerified} />
                  </AdminUserDetail>
                  <AdminUserDetail label="Created">
                    {formatDateTime(user.createdAt)}
                  </AdminUserDetail>
                  <AdminUserDetail label="Updated">
                    {formatDateTime(user.updatedAt)}
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

function UnknownAdminSection() {
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
          <Button type="button" onClick={() => navigateTo("/admin/users")}>
            <UsersRound data-icon="inline-start" />
            Users
          </Button>
        </div>
      </div>
    </section>
  )
}

function AdminUserActionsMenu({
  currentUserId,
  deletingUserId,
  onDeleteUser,
  openUserMenuId,
  setOpenUserMenuId,
  user,
}: {
  currentUserId: string
  deletingUserId: string | null
  onDeleteUser: (user: AdminUser) => void
  openUserMenuId: string | null
  setOpenUserMenuId: Dispatch<SetStateAction<string | null>>
  user: AdminUser
}) {
  const isCurrentUser = user.id === currentUserId
  const isDeleting = deletingUserId === user.id
  const isOpen = openUserMenuId === user.id

  return (
    <div className="relative flex justify-end">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Open actions for ${user.email}`}
        aria-expanded={isOpen}
        title="User actions"
        disabled={isDeleting}
        onClick={() =>
          setOpenUserMenuId((currentUserMenuId) =>
            currentUserMenuId === user.id ? null : user.id
          )
        }
      >
        <MoreVertical />
      </Button>

      {isOpen ? (
        <>
          <button
            className="fixed inset-0 z-10 cursor-default"
            type="button"
            aria-label="Close user actions"
            onClick={() => setOpenUserMenuId(null)}
          />
          <div className="absolute top-9 right-0 z-20 w-52 overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-2xl shadow-black/40">
            {isCurrentUser ? (
              <button
                className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground opacity-70"
                type="button"
                disabled
              >
                <UserRound data-icon="inline-start" />
                Current account
              </button>
            ) : (
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                type="button"
                disabled={isDeleting}
                onClick={() => {
                  setOpenUserMenuId(null)
                  onDeleteUser(user)
                }}
              >
                <Trash2 data-icon="inline-start" />
                Delete user
              </button>
            )}
          </div>
        </>
      ) : null}
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
  const isAdmin = roleLabel
    .split(",")
    .map((rolePart) => rolePart.trim().toLowerCase())
    .includes("admin")

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

function formatDateTime(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value || "Unknown"
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}
