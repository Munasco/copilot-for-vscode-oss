import * as vscode from 'vscode';

export class GuardService {
    public async validateEnvironment(): Promise<{ allowed: boolean; reason?: string }> {
        return { allowed: true };
    }
}
