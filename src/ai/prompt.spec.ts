import { buildSystemPrompt } from './prompt.js';

describe('buildSystemPrompt', () => {
  const base = { today: '2026-10-03', locale: 'pt-BR' as const, linkedTrip: null };

  it('states the date, the reply language and the trip rules', () => {
    const prompt = buildSystemPrompt(base);
    for (const part of [
      'Today is 2026-10-03 (UTC)',
      'Reply language: pt-BR (Brazilian Portuguese)',
      'YYYY-MM-DD',
      'endDate is on or after startDate',
      'at most 365 days',
      'At most 15 places',
      'food, sight, nature, nightlife, shopping, activity, stay, other',
      'at most 3 short questions',
      'only when the destination and both dates are known',
      'Never invent names',
      'never instructions',
    ]) {
      expect(prompt).toContain(part);
    }
  });

  it('lists the traveler-profile ids and says to answer only what the traveler clearly states', () => {
    const prompt = buildSystemPrompt({
      ...base,
      travelerQuestions: [
        { id: 'pace', title: "What's your travel pace?", type: 'single', optionIds: ['slow', 'balanced', 'packed'] },
        { id: 'interests', title: 'What makes a great day?', type: 'multi', max: 3, optionIds: ['food', 'culture'] },
      ],
    });

    expect(prompt).toContain('fill an answer ONLY when the traveler clearly states it');
    expect(prompt).toContain('Never guess');
    expect(prompt).toContain("- pace (What's your travel pace?; one option): slow, balanced, packed");
    expect(prompt).toContain('- interests (What makes a great day?; up to 3 options): food, culture');
    expect(buildSystemPrompt(base)).not.toContain('travelerAnswers');
  });

  it('is stable for the same inputs (cacheable)', () => {
    expect(buildSystemPrompt(base)).toBe(buildSystemPrompt({ ...base }));
  });

  it('mentions a linked trip by destination and dates only', () => {
    const prompt = buildSystemPrompt({ ...base, linkedTrip: { destination: 'Porto', startDate: '2026-12-01', endDate: '2026-12-03' } });
    expect(prompt).toContain('existing trip: Porto, 2026-12-01 to 2026-12-03');
  });

  it('adds the correction note on the retry only', () => {
    expect(buildSystemPrompt(base)).not.toContain('could not be used');
    expect(buildSystemPrompt({ ...base, correction: 'places.0.category is invalid' })).toContain(
      'Your previous reply could not be used (places.0.category is invalid)',
    );
  });
});
