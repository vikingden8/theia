/********************************************************************************
 * Copyright (C) 2018 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { injectable, inject } from 'inversify';
import { Resource, ResourceVersion, ResourceResolver, ResourceError, ResourceSaveOptions } from '@theia/core/lib/common/resource';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { Emitter, Event } from '@theia/core/lib/common/event';
import URI from '@theia/core/lib/common/uri';
import { FileOperation, FileOperationError, FileOperationResult, ETAG_DISABLED, FileSystemProviderCapabilities } from '../common/files';
import { FileService } from './file-service';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { LabelProvider } from '@theia/core/lib/browser/label-provider';

export interface FileResourceVersion extends ResourceVersion {
    readonly encoding: string;
    readonly mtime: number;
    readonly etag: string;
}
export namespace FileResourceVersion {
    export function is(version: ResourceVersion | undefined): version is FileResourceVersion {
        return !!version && 'encoding' in version && 'mtime' in version && 'etag' in version;
    }
}

export interface FileResourceOptions {
    shouldOverwrite: () => Promise<boolean>
}

export class FileResource implements Resource {

    protected readonly toDispose = new DisposableCollection();
    protected readonly onDidChangeContentsEmitter = new Emitter<void>();
    readonly onDidChangeContents: Event<void> = this.onDidChangeContentsEmitter.event;

    protected _version: FileResourceVersion | undefined;
    get version(): FileResourceVersion | undefined {
        return this._version;
    }
    get encoding(): string | undefined {
        return this._version?.encoding;
    }

    constructor(
        readonly uri: URI,
        protected readonly fileService: FileService,
        protected readonly options: FileResourceOptions
    ) {
        this.toDispose.push(this.onDidChangeContentsEmitter);
        this.toDispose.push(this.fileService.onDidFilesChange(event => {
            if (event.contains(this.uri)) {
                this.sync();
            }
        }));
        this.toDispose.push(this.fileService.onDidRunOperation(e => {
            if ((e.isOperation(FileOperation.DELETE) || e.isOperation(FileOperation.MOVE)) && e.resource.isEqualOrParent(this.uri)) {
                this.sync();
            }
        }));
        try {
            this.toDispose.push(this.fileService.watch(this.uri));
        } catch (e) {
            console.error(e);
        }
        this.updateSavingContentChanges();
        this.toDispose.push(this.fileService.onDidChangeFileSystemProviderCapabilities(e => {
            if (e.scheme === this.uri.scheme) {
                this.updateSavingContentChanges();
            }
        }));
    }

    dispose(): void {
        this.toDispose.dispose();
    }

    async readContents(options?: { encoding?: string }): Promise<string> {
        try {
            const encoding = options?.encoding || this.version?.encoding;
            const stat = await this.fileService.read(this.uri, { encoding, etag: ETAG_DISABLED });
            this._version = {
                encoding: stat.encoding,
                etag: stat.etag,
                mtime: stat.mtime
            };
            return stat.value;
        } catch (e) {
            if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
                this._version = undefined;
                const { message, stack } = e;
                throw ResourceError.NotFound({
                    message, stack,
                    data: {
                        uri: this.uri
                    }
                });
            }
            throw e;
        }
    }

    async saveContents(content: string, options?: ResourceSaveOptions): Promise<void> {
        const version = options?.version || this._version;
        const current = FileResourceVersion.is(version) ? version : undefined;
        const etag = current?.etag;
        try {
            const stat = await this.fileService.write(this.uri, content, {
                encoding: options?.encoding,
                overwriteEncoding: options?.overwriteEncoding,
                etag,
                mtime: current?.mtime
            });
            this._version = {
                etag: stat.etag,
                mtime: stat.mtime,
                encoding: stat.encoding
            };
        } catch (e) {
            if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE) {
                if (etag !== ETAG_DISABLED && await this.shouldOverwrite()) {
                    return this.saveContents(content, { ...options, version: { stat: { ...current, etag: ETAG_DISABLED } } });
                }
                const { message, stack } = e;
                throw ResourceError.OutOfSync({ message, stack, data: { uri: this.uri } });
            }
            throw e;
        }
    }

    saveContentChanges?: Resource['saveContentChanges'];
    protected updateSavingContentChanges(): void {
        if (this.fileService.hasCapability(this.uri, FileSystemProviderCapabilities.Update)) {
            this.saveContentChanges = this.doSaveContentChanges;
        } else {
            delete this.saveContentChanges;
        }
    }
    protected doSaveContentChanges: Resource['saveContentChanges'] = async (changes, options) => {
        const version = options?.version || this._version;
        const current = FileResourceVersion.is(version) ? version : undefined;
        if (!current) {
            throw ResourceError.NotFound({ message: 'has not been read yet', data: { uri: this.uri } });
        }
        const etag = current?.etag;
        try {
            const stat = await this.fileService.update(this.uri, changes, {
                readEncoding: current.encoding,
                encoding: options?.encoding,
                overwriteEncoding: options?.overwriteEncoding,
                etag,
                mtime: current?.mtime
            });
            this._version = {
                etag: stat.etag,
                mtime: stat.mtime,
                encoding: stat.encoding
            };
        } catch (e) {
            if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
                const { message, stack } = e;
                throw ResourceError.NotFound({ message, stack, data: { uri: this.uri } });
            }
            if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE) {
                const { message, stack } = e;
                throw ResourceError.OutOfSync({ message, stack, data: { uri: this.uri } });
            }
            throw e;
        }
    };

    async guessEncoding(): Promise<string> {
        const content = await this.fileService.read(this.uri, { autoGuessEncoding: true });
        return content.encoding;
    }

    protected async sync(): Promise<void> {
        if (await this.isInSync()) {
            return;
        }
        this.onDidChangeContentsEmitter.fire(undefined);
    }
    protected async isInSync(): Promise<boolean> {
        try {
            const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
            return !!this.version && this.version.mtime >= stat.mtime;
        } catch {
            return !this.version;
        }
    }

    protected async shouldOverwrite(): Promise<boolean> {
        return this.options.shouldOverwrite();
    }

}

@injectable()
export class FileResourceResolver implements ResourceResolver {

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;

    async resolve(uri: URI): Promise<FileResource> {
        let stat;
        try {
            stat = await this.fileService.resolve(uri);
        } catch (e) {
            if (!(e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
                throw e;
            }
        }
        if (stat && stat.isDirectory) {
            throw new Error('The given uri is a directory: ' + this.labelProvider.getLongName(uri));
        }
        return new FileResource(uri, this.fileService, {
            shouldOverwrite: () => this.shouldOverwrite(uri)
        });
    }

    protected async shouldOverwrite(uri: URI): Promise<boolean> {
        const dialog = new ConfirmDialog({
            title: `The file '${this.labelProvider.getName(uri)}' has been changed on the file system.`,
            msg: `Do you want to overwrite the changes made to '${this.labelProvider.getLongName(uri)}' on the file system?`,
            ok: 'Yes',
            cancel: 'No'
        });
        return !!await dialog.open();
    }

}
