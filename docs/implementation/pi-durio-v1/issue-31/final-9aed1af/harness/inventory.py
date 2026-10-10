#!/usr/bin/env python3
"""Read-only size/maintenance inventory for a later explicitly fixed candidate."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import plistlib
import stat
import subprocess
import tarfile

def command(*argv):
    return subprocess.check_output(argv, text=True).strip()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def classify(path):
    first = pathlib.PurePosixPath(path).parts[0]
    return {'src':'product', 'test':'tests', 'scripts':'scripts', 'docs':'documentation',
            'vendor':'vendor', 'dist':'generated'}.get(first, 'root-config-and-other')

def inventory(root, paths):
    rows = []
    unique = set()
    allocated_unique = 0
    for relative in sorted(paths):
        path = root / relative
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            rows.append({'path':relative,'kind':'symlink','target':target,
                         'sha256':sha(('link:' + target).encode())})
            continue
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError('Unsupported inventory entry: ' + str(path))
        data = path.read_bytes()
        lines = None
        if b'\0' not in data:
            try:
                data.decode('utf-8')
                lines = data.count(b'\n') + (1 if data and not data.endswith(b'\n') else 0)
            except UnicodeDecodeError:
                pass
        allocated = info.st_blocks * 512
        inode = (info.st_dev, info.st_ino)
        if inode not in unique:
            allocated_unique += allocated
            unique.add(inode)
        rows.append({'path':relative,'kind':'file','bytes':len(data),
                     'allocatedBytes':allocated,'textLines':lines,'sha256':sha(data)})
    return {'regularFiles':sum(r['kind']=='file' for r in rows),
            'symlinks':sum(r['kind']=='symlink' for r in rows),
            'logicalBytes':sum(r.get('bytes',0) for r in rows),
            'allocatedBytesByPath':sum(r.get('allocatedBytes',0) for r in rows),
            'allocatedBytesUniqueInode':allocated_unique,
            'physicalTextLines':sum(r.get('textLines') or 0 for r in rows),
            'rows':rows}

def tree_paths(root):
    paths = []
    for base, dirs, files in os.walk(root, followlinks=False):
        base = pathlib.Path(base)
        for name in dirs + files:
            path = base / name
            if path.is_symlink() or path.is_file():
                paths.append(path.relative_to(root).as_posix())
    return paths

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=pathlib.Path, required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--install-root', type=pathlib.Path, required=True)
    parser.add_argument('--distribution', type=pathlib.Path, required=True)
    parser.add_argument('--node', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.output.exists(): raise RuntimeError('Never overwrite a measurement result')
    root = args.repo.resolve()
    head = command('git','-C',str(root),'rev-parse','HEAD')
    if head != args.candidate: raise RuntimeError('Candidate differs from the declared HEAD')
    if command('git','-C',str(root),'status','--porcelain','--untracked-files=no'):
        raise RuntimeError('Tracked source is dirty')
    files = subprocess.check_output(['git','-C',str(root),'ls-files','-z']).decode().rstrip('\0').split('\0')
    groups = {}
    for relative in files: groups.setdefault(classify(relative),[]).append(relative)
    source = {name:inventory(root,paths) for name,paths in groups.items()}
    install = args.install_root.resolve()
    installed = inventory(install,tree_paths(install))
    installed_groups = {}
    for relative in tree_paths(install):
        if relative.startswith('node_modules/pi-durio/node_modules/'):
            category = 'bundled-production-dependencies'
        elif relative.startswith('node_modules/pi-durio/vendor/'):
            category = 'package-vendor-archives'
        elif relative.startswith('node_modules/pi-durio/'):
            category = 'package-own-files'
        elif relative.startswith('node_modules/'):
            category = 'other-installed-modules-and-links'
        else:
            category = 'installation-root-files'
        installed_groups.setdefault(category, []).append(relative)
    installed_breakdown = {name: inventory(install, paths) for name, paths in installed_groups.items()}
    tar_entries = []
    with tarfile.open(args.distribution, 'r:*') as archive:
        for member in archive.getmembers():
            kind = 'file' if member.isfile() else 'directory' if member.isdir() else 'symlink' if member.issym() else 'hardlink' if member.islnk() else 'other'
            row = {'path':member.name,'kind':kind,'bytes':member.size,'mode':member.mode}
            if member.isfile(): row['sha256'] = sha(archive.extractfile(member).read())
            if member.issym() or member.islnk(): row['target'] = member.linkname
            tar_entries.append(row)
    source_build = install / 'node_modules/pi-durio/dist/execution/source-build.json'
    package = args.distribution.read_bytes()
    terminal_plist = pathlib.Path('/System/Applications/Utilities/Terminal.app/Contents/Info.plist')
    terminal_version = None
    if terminal_plist.exists():
        terminal_version = plistlib.loads(terminal_plist.read_bytes()).get('CFBundleShortVersionString')
    result = {'schema':'pi-durio-local-inventory-v1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'candidate':head,'tree':command('git','-C',str(root),'rev-parse','HEAD^{tree}'),
        'harness':{'path':str(pathlib.Path(__file__).resolve()),'sha256':sha(pathlib.Path(__file__).read_bytes())},
        'machine':{'os':command('sw_vers','-productVersion'),'architecture':command('uname','-m'),
                   'model':command('sysctl','-n','hw.model'),'memoryBytes':int(command('sysctl','-n','hw.memsize')),
                   'node':str(args.node.resolve()),'nodeVersion':command(str(args.node),'--version'),
                   'terminalVersion':terminal_version},
        'sourceCategories':source,'installation':{'root':str(install),**installed},
        'installationBreakdown':installed_breakdown,
        'nativeModules':[row for row in installed['rows'] if row['path'].endswith('.node')],
        'installedSourceBuild':{'path':str(source_build),'sha256':sha(source_build.read_bytes())},
        'distribution':{'path':str(args.distribution.resolve()),'compressedBytes':len(package),'sha256':sha(package),
            'unpackedRegularFiles':sum(row['kind']=='file' for row in tar_entries),
            'unpackedLogicalFileBytes':sum(row['bytes'] for row in tar_entries if row['kind']=='file'),
            'entries':tar_entries},
        'accounting':{'source':'All Git-tracked paths, grouped by literal first path component; untracked originals are excluded from owned source and preserved.',
          'installation':'Every ordinary file and symlink under the supplied complete install root; bundled and duplicate copies count by path.',
          'node':'The external Node executable is recorded but excluded from installation size.',
          'devDependencies':'NOT INFERRED; inspect the dependency inventory and original install command separately.',
          'allocated':'st_blocks times 512; by-path and unique-inode totals are both retained. APFS clones/snapshots/shared extents are not measured as unique physical disk usage.',
          'lines':'Physical UTF-8 text lines, including comments/blanks; binary files have null line count. Counts are not a quality or lightweight score.'},
        'limits':['Read-only inventory, not behavioral acceptance, timing, RSS or provider measurement.',
                  'Source/build/package correspondence must be verified separately using the frozen candidate manifest.',
                  'Actual Terminal profile and viewport belong to the later native measurement record.']}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as stream: json.dump(result,stream,ensure_ascii=False,indent=2);stream.write('\n')
    print(json.dumps({'output':str(args.output),'sha256':sha(args.output.read_bytes()),
                      'sourceFiles':len(files),'installedFiles':installed['regularFiles'],
                      'installedLogicalBytes':installed['logicalBytes']},ensure_ascii=False))

if __name__ == '__main__': main()
