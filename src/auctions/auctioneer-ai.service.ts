import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/**
 * AI Auctioneer Service
 *
 * Generates realistic auctioneer commentary using Google Gemini AI
 * Provides dynamic, contextual auction commentary
 * Integrates with Google Text-to-Speech API for voice generation
 */
@Injectable()
export class AuctioneerAiService {
  private geminiApiKey: string;
  private geminiApiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';

  constructor(private configService: ConfigService) {
    this.geminiApiKey = this.configService.get<string>('GEMINI_API_KEY') || '';
  }

  /**
   * Generate auctioneer commentary for different auction events
   */
  generateAuctioneerMessage(eventType: string, data: any): string {
    switch (eventType) {
      case 'auction_started':
        return this.generateStartMessage(data);

      case 'new_bid':
        return this.generateBidMessage(data);

      case 'going_once':
        return this.generateGoingOnceMessage(data);

      case 'going_twice':
        return this.generateGoingTwiceMessage(data);

      case 'sold':
        return this.generateSoldMessage(data);

      case 'no_sale':
        return this.generateNoSaleMessage(data);

      case 'bid_increment':
        return this.generateIncrementMessage(data);

      default:
        return 'Thank you for participating in this auction.';
    }
  }

  /**
   * Generate dynamic AI-powered auctioneer commentary using Gemini
   * Provides contextual, energetic commentary for live auctions
   */
  async generateAICommentary(eventType: string, data: any): Promise<string> {
    // Fallback to template messages if API key not configured
    if (!this.geminiApiKey) {
      return this.generateAuctioneerMessage(eventType, data);
    }

    try {
      const prompt = this.buildAuctioneerPrompt(eventType, data);

      const response = await axios.post(
        `${this.geminiApiUrl}?key=${this.geminiApiKey}`,
        {
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.9, // Higher creativity for energetic commentary
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 150,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      const aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (aiResponse) {
        return aiResponse.trim();
      }

      // Fallback to template if AI response is empty
      return this.generateAuctioneerMessage(eventType, data);

    } catch (error) {
      console.error('Error generating AI commentary:', error);
      // Fallback to template messages
      return this.generateAuctioneerMessage(eventType, data);
    }
  }

  /**
   * Build Gemini prompt for auction commentary
   */
  private buildAuctioneerPrompt(eventType: string, data: any): string {
    const baseContext = `You are a professional, energetic auctioneer conducting a live online auction. Generate a brief (1-2 sentences), enthusiastic commentary in the style of a traditional auctioneer.`;

    switch (eventType) {
      case 'auction_started':
        return `${baseContext} The auction for "${data.title || 'this item'}" is starting. Opening bid is ₣${data.starting_price}. Category: ${data.category || 'General'}. Make it vibey and exciting for Gen Z/Millennial audience (ages 15-40).`;

      case 'new_bid':
        return `${baseContext} A new bid of ₣${data.amount} has been placed${data.bidder_display_id ? ` by ${data.bidder_display_id}` : ''}. Current bid count: ${data.total_bids || 0}. Next increment: ₣${data.next_increment}. Keep the energy high!`;

      case 'going_once':
        return `${baseContext} The current bid is ₣${data.current_bid}. Time is running out. Say "Going once..." with urgency to encourage more bids.`;

      case 'going_twice':
        return `${baseContext} The current bid is ₣${data.current_bid}. This is the last chance! Say "Going twice..." with even more urgency.`;

      case 'sold':
        return `${baseContext} The auction has ended! The winning bid is ₣${data.winning_bid}${data.winner_display_id ? ` by ${data.winner_display_id}` : ''}. Announce "SOLD!" with celebration and congratulations.`;

      case 'no_sale':
        return `${baseContext} The auction ended without meeting the reserve price. Politely announce no sale and thank participants.`;

      case 'bid_war':
        return `${baseContext} There's intense bidding activity! ${data.recent_bids || 3} bids in the last minute. Current bid: ₣${data.current_bid}. Create excitement about the bidding war!`;

      default:
        return `${baseContext} Generate a brief, enthusiastic message encouraging bidders to participate.`;
    }
  }

  /**
   * Generate auction start commentary
   */
  private generateStartMessage(data: any): string {
    const startPhrases = [
      `Welcome everyone to this exciting auction!`,
      `Good ${this.getTimeOfDay()}, ladies and gentlemen!`,
      `Thank you all for joining us today!`,
      `Welcome to what promises to be an exceptional auction!`,
    ];

    const itemIntros = [
      `We're presenting a fantastic ${data.category || 'item'} today.`,
      `Up for auction is this remarkable piece.`,
      `Our next lot is truly special.`,
      `This is an exceptional opportunity for collectors.`,
    ];

    const startingBidPhrases = [
      `We'll start the bidding at ${data.starting_price} Freti.`,
      `The opening bid is set at ${data.starting_price} Freti.`,
      `Let's begin with ${data.starting_price} Freti.`,
      `We're starting at ${data.starting_price} Freti.`,
    ];

    return `${this.randomChoice(startPhrases)} ${this.randomChoice(itemIntros)} ${this.randomChoice(startingBidPhrases)} Do I hear ${data.starting_price} Freti?`;
  }

  /**
   * Generate new bid commentary
   */
  private generateBidMessage(data: any): string {
    const acknowledgments = [
      `Thank you! I have ${data.amount} Freti.`,
      `${data.amount} Freti, thank you!`,
      `I've got ${data.amount} Freti from ${data.bidder_display_id}.`,
      `${data.amount} Freti bid, thank you!`,
    ];

    const nextBidPhrases = [
      `Now looking for ${data.next_increment} Freti.`,
      `Can I get ${data.next_increment} Freti?`,
      `Do I hear ${data.next_increment} Freti?`,
      `Who'll give me ${data.next_increment} Freti?`,
    ];

    return `${this.randomChoice(acknowledgments)} ${this.randomChoice(nextBidPhrases)}`;
  }

  /**
   * Generate "going once" commentary
   */
  private generateGoingOnceMessage(data: any): string {
    const phrases = [
      `Going once at ${data.current_bid} Freti...`,
      `${data.current_bid} Freti going once...`,
      `I have ${data.current_bid} Freti, going once...`,
      `Fair warning at ${data.current_bid} Freti, going once...`,
    ];

    return this.randomChoice(phrases);
  }

  /**
   * Generate "going twice" commentary
   */
  private generateGoingTwiceMessage(data: any): string {
    const phrases = [
      `Going twice at ${data.current_bid} Freti...`,
      `${data.current_bid} Freti going twice...`,
      `Going twice for ${data.current_bid} Freti...`,
      `Last chance at ${data.current_bid} Freti, going twice...`,
    ];

    return this.randomChoice(phrases);
  }

  /**
   * Generate "sold" commentary
   */
  private generateSoldMessage(data: any): string {
    const soldPhrases = [
      `SOLD! For ${data.winning_bid} Freti to ${data.winner_display_id}!`,
      `Sold for ${data.winning_bid} Freti! Congratulations ${data.winner_display_id}!`,
      `SOLD to ${data.winner_display_id} for ${data.winning_bid} Freti!`,
      `Going... going... SOLD! ${data.winning_bid} Freti to ${data.winner_display_id}!`,
    ];

    const congratulations = [
      `Congratulations on your winning bid!`,
      `An excellent purchase!`,
      `Well done!`,
      `A fantastic addition to your collection!`,
    ];

    return `${this.randomChoice(soldPhrases)} ${this.randomChoice(congratulations)}`;
  }

  /**
   * Generate "no sale" commentary
   */
  private generateNoSaleMessage(data: any): string {
    const phrases = [
      `No sale. Reserve price was not met.`,
      `The item will be passed. Reserve not reached.`,
      `No sale today. Thank you for your interest.`,
      `The reserve price was not achieved. No sale.`,
    ];

    return this.randomChoice(phrases);
  }

  /**
   * Generate bid increment encouragement
   */
  private generateIncrementMessage(data: any): string {
    const encouragements = [
      `The bid increment is ${data.increment} Freti.`,
      `Bids are accepted in ${data.increment} Freti increments.`,
      `Minimum increment is ${data.increment} Freti.`,
      `Please bid in ${data.increment} Freti increments.`,
    ];

    const motivations = [
      `Don't miss this opportunity!`,
      `This is a rare find!`,
      `A great investment piece!`,
      `Perfect for any collection!`,
    ];

    return `${this.randomChoice(encouragements)} ${this.randomChoice(motivations)}`;
  }

  /**
   * Generate text-to-speech audio (placeholder for Google TTS integration)
   */
  async generateSpeech(text: string, options?: {
    voice?: 'male' | 'female';
    speed?: number;
    pitch?: number;
  }): Promise<string | null> {
    try {
      // TODO: Integrate with Google Text-to-Speech API
      // For now, return a placeholder URL

      // Example implementation would be:
      // const textToSpeech = require('@google-cloud/text-to-speech');
      // const client = new textToSpeech.TextToSpeechClient();
      //
      // const request = {
      //   input: { text },
      //   voice: {
      //     languageCode: 'en-US',
      //     name: options?.voice === 'female' ? 'en-US-Wavenet-F' : 'en-US-Wavenet-D',
      //     ssmlGender: options?.voice === 'female' ? 'FEMALE' : 'MALE',
      //   },
      //   audioConfig: {
      //     audioEncoding: 'MP3',
      //     speakingRate: options?.speed || 1.0,
      //     pitch: options?.pitch || 0,
      //   },
      // };
      //
      // const [response] = await client.synthesizeSpeech(request);
      // const audioContent = response.audioContent;
      //
      // // Save to storage and return URL
      // return await this.saveAudioToStorage(audioContent);

      console.log(`TTS requested for: "${text}"`);
      return null; // Placeholder until TTS is implemented

    } catch (error) {
      console.error('Error generating speech:', error);
      return null;
    }
  }

  /**
   * Get crowd reaction sound based on bid activity
   */
  getCrowdReaction(bidCount: number, bidAmount: number): string {
    if (bidAmount > 10000) {
      return 'crowd_excited_high.mp3';
    } else if (bidAmount > 1000) {
      return 'crowd_impressed.mp3';
    } else if (bidCount > 20) {
      return 'crowd_active.mp3';
    } else {
      return 'crowd_murmur.mp3';
    }
  }

  /**
   * Generate gavel sound effect timing
   */
  getGavelTiming(eventType: string): { delay: number; sound: string } {
    switch (eventType) {
      case 'going_once':
        return { delay: 2000, sound: 'gavel_light.mp3' };
      case 'going_twice':
        return { delay: 2000, sound: 'gavel_medium.mp3' };
      case 'sold':
        return { delay: 1000, sound: 'gavel_final.mp3' };
      default:
        return { delay: 0, sound: 'gavel_light.mp3' };
    }
  }

  /**
   * Helper: Get random choice from array
   */
  private randomChoice(array: string[]): string {
    return array[Math.floor(Math.random() * array.length)];
  }

  /**
   * Helper: Get time of day greeting
   */
  private getTimeOfDay(): string {
    const hour = new Date().getHours();
    if (hour < 12) return 'morning';
    if (hour < 17) return 'afternoon';
    return 'evening';
  }
}