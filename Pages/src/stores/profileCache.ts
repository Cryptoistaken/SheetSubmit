import { create } from "zustand";
import { api } from "@/lib/api";

export type CachedProfile = {
  id: string;
  name: string;
  username?: string | null;
  photoUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  isAdmin?: boolean;
};

type State = {
  profiles: Record<string, CachedProfile>;
  fetchedAt: number | null;
  isFetching: boolean;
  fetchProfiles: (force?: boolean) => Promise<void>;
  setProfiles: (list: CachedProfile[] | unknown[]) => void;
};

export const useProfileCache = create<State>((set, get) => ({
  profiles: {},
  fetchedAt: null,
  isFetching: false,
  setProfiles: (list) => {
    const cur = get().profiles;
    const map: Record<string, CachedProfile> = { ...cur };
    for (const u of list as unknown as { id?: string; userId?: string; firstName?: string; lastName?: string; username?: string; photoUrl?: string | null; isAdmin?: boolean; name?: string; displayName?: string }[]) {
      const id = (u.id ?? (u as unknown as { userId?: string }).userId) as string;
      if (!id) continue;
      const name = (u.name as string) || (u.displayName as string) || `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || (u.username ? `@${u.username}` : id);
      map[id] = { id, name, username: u.username ?? null, photoUrl: u.photoUrl ?? null, firstName: u.firstName ?? null, lastName: u.lastName ?? null, isAdmin: (u as { isAdmin?: boolean }).isAdmin };
    }
    set({ profiles: map });
  },
  fetchProfiles: async (force) => {
    const { fetchedAt, isFetching, profiles } = get();
    if (!force && fetchedAt && Date.now() - fetchedAt < 5 * 60 * 1000 && Object.keys(profiles).length) return;
    if (isFetching) return;
    set({ isFetching: true });
    try {
      const users = (await api.adminUsers()) as unknown as { id: string; firstName?: string; lastName?: string; username?: string; photoUrl?: string | null }[];
      const map: Record<string, CachedProfile> = {};
      for (const u of users) {
        const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || (u.username ? `@${u.username}` : u.id);
        map[u.id] = { id: u.id, name, username: u.username ?? null, photoUrl: u.photoUrl ?? null, firstName: u.firstName ?? null, lastName: u.lastName ?? null };
      }
      set({ profiles: map, fetchedAt: Date.now() });
    } catch {
      // keep stale cache
    } finally {
      set({ isFetching: false });
    }
  },
}));
