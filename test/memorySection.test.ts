import { describe, it, expect } from 'vitest';
import { memorySection } from '../src/memorySection';

const hit = (over: any = {}) => ({ memory_hit: true, memory_times_seen: 3, ...over });

describe('memorySection — null means nothing remembered, never an empty heading', () => {
    it.each([null, undefined, {}, { memory_hit: false }])('returns null for %p', (r) => {
        expect(memorySection(r as any)).toBeNull();
    });

    it('never returns a blank section', () => {
        // A "## Seen before" with nothing under it reads as a lookup that ran
        // and found the error is new, which is the opposite of the truth.
        for (const state of ['confirmed', 'unproven', 'anti_pattern', 'none', 'weird', undefined]) {
            const out = memorySection(hit({ memory_fix_state: state }))!;
            expect(out).toContain('## Seen before');
            expect(out.split('## Seen before')[1].trim().length).toBeGreaterThan(20);
        }
    });
});

describe('the four states are four different instructions to an agent', () => {
    it('confirmed AND observed says so, because that is the strongest claim here', () => {
        const out = memorySection(hit({ memory_fix_state: 'confirmed', memory_verified_count: 2 }))!;
        expect(out).toContain('VERIFIED BY OBSERVATION 2x');
        expect(out).toContain('3x before in this project');
    });

    it('confirmed but never observed is a strong lead, not proof', () => {
        const out = memorySection(hit({ memory_fix_state: 'confirmed', memory_verified_count: 0 }))!;
        expect(out).not.toContain('VERIFIED BY OBSERVATION');
        expect(out).toContain('strong lead, not proof');
    });

    it('unproven says the error came back', () => {
        expect(memorySection(hit({ memory_fix_state: 'unproven' }))!).toContain('RECURRED');
    });

    it('anti_pattern tells the agent not to propose it again', () => {
        // The loop this whole feature exists to break: re-proposing the fix
        // that already did not work.
        const out = memorySection(hit({ memory_fix_state: 'anti_pattern' }))!;
        expect(out).toContain('KEPT HAPPENING');
        expect(out).toContain('not to propose it again');
    });

    it('none says nothing is confirmed, rather than implying a failure', () => {
        const out = memorySection(hit({ memory_fix_state: 'none' }))!;
        expect(out).toContain('No fix has been confirmed');
        expect(out).not.toContain('did not work');
    });
});

describe('older engines', () => {
    it('falls back to the boolean when the engine sends no state', () => {
        // Deploy order: an engine that predates memory_fix_state still sends
        // memory_fix_confirmed, and the two must not disagree.
        expect(memorySection(hit({ memory_fix_confirmed: true }))!).toContain('accepted by a developer');
        expect(memorySection(hit({ memory_fix_confirmed: false }))!).toContain('No fix has been confirmed');
    });

    it('omits the count rather than inventing one when times_seen is absent', () => {
        const out = memorySection({ memory_hit: true })!;
        expect(out).toContain('seen before in this project');
        expect(out).not.toMatch(/\bundefinedx\b|\bNaNx\b/);
    });

    it('ignores a state string it does not know instead of throwing', () => {
        expect(memorySection(hit({ memory_fix_state: 'something_new' }))!).toContain('No fix has been confirmed');
    });
});
