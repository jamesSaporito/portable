# `portable update`: moves the installed copy forward to its GitHub branch. Expects lib/launch.sh.

update_portable() {
  local dir="$PORTABLE_INSTALL_DIR" incoming
  if [ ! -d "$dir/.git" ]; then
    echo "portable: no installed copy in $dir; run install.sh from a clone of portable" >&2
    return 1
  fi
  # Only GitHub's commits reach it, so changes made in a session arrive after they're merged.
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    echo "portable: $dir has local changes; make changes in a clone of portable and merge them on GitHub instead" >&2
    git -C "$dir" status --short >&2
    return 1
  fi
  git -C "$dir" fetch --quiet || return
  incoming="$(git -C "$dir" log --oneline 'HEAD..@{u}')"
  if [ -z "$incoming" ]; then
    echo "portable is up to date ($(git -C "$dir" log -1 --format=%h))"
    return
  fi
  echo "Updating portable with:"
  sed 's/^/  /' <<< "$incoming"
  if ! git -C "$dir" merge --quiet --ff-only '@{u}'; then
    echo "portable: couldn't fast-forward $dir (its history differs from GitHub's)" >&2
    return 1
  fi
  echo "Updated. If kit/ changed, sandboxes created before this keep the old kit; 'portable rm' them to rebuild."
}
