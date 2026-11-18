#!/bin/sh
# Make a full mirror backup of a repository, including every ref, and write a
# checksum. Nothing in the source repository is changed.
#
#   scripts/backup-mirror.sh [source] [destination-root]
#
# source defaults to this checkout (including local branches and refs/t3) and
# destination to $HOME/bankpipe-backups. Pass a URL to mirror the GitHub view
# separately. Keep the destination on an encrypted disk and copy the archive
# off the machine. Never put a backup inside the repository.
set -eu

source_url="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
destination_root="${2:-${HOME}/bankpipe-backups}"

case "$destination_root" in
  /*) ;;
  *) echo "destination root must be an absolute path: $destination_root" >&2; exit 1 ;;
esac

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
case "$destination_root" in
  "$repository_root"|"$repository_root"/*)
    echo "destination must be outside the repository" >&2
    exit 1
    ;;
esac

mkdir -p "$destination_root"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mirror="$destination_root/bankpipe-$stamp.git"
[ ! -e "$mirror" ] || { echo "refusing to overwrite $mirror" >&2; exit 1; }

git clone --mirror "$source_url" "$mirror"
git -C "$mirror" fsck --full --no-dangling

manifest="$destination_root/bankpipe-$stamp.refs.txt"
git -C "$mirror" for-each-ref --format='%(refname) %(objectname)' > "$manifest"
commits="$(git -C "$mirror" rev-list --all --count)"
printf 'commits %s\n' "$commits" >> "$manifest"

archive="$destination_root/bankpipe-$stamp.tar.gz"
tar -C "$destination_root" -czf "$archive" "$(basename "$mirror")"

if command -v sha256sum >/dev/null 2>&1; then
  checksum="$(sha256sum "$archive" | awk '{print $1}')"
else
  checksum="$(shasum -a 256 "$archive" | awk '{print $1}')"
fi
printf '%s  %s\n' "$checksum" "$(basename "$archive")" > "$archive.sha256"

printf 'mirror   %s\narchive  %s\nchecksum %s\nrefs     %s\ncommits  %s\n' \
  "$mirror" "$archive" "$checksum" "$manifest" "$commits"
