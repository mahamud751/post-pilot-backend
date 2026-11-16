import {checkCompliance} from './compliance';

const brand = {
  products: [{name: 'Iced latte', price: '৳350'}],
  approvedOffers: [{title: '10% off weekday mornings'}],
  doNotSay: ['cheapest'],
};

const codes = (text: string, b = brand) => checkCompliance(text, b).map(f => f.code);

describe('checkCompliance (PRD TEST-13)', () => {
  it('allows prices and offers from the brand kit', () => {
    expect(codes('Iced latte for ৳350. Enjoy 10% off weekday mornings!')).toEqual([]);
  });

  it('flags an invented price', () => {
    expect(codes('Iced latte now only ৳299!')).toEqual(['unverified_price']);
    expect(codes('Only 199 taka today')).toEqual(['unverified_price']);
  });

  it('reads Bengali digits', () => {
    expect(codes('মাত্র ৳২৯৯')).toEqual(['unverified_price']);
    expect(codes('মাত্র ৳৩৫০')).toEqual([]);
  });

  it('flags an invented discount', () => {
    expect(codes('Get 50% off this weekend')).toEqual(['unverified_offer']);
  });

  it('flags any promotion when no offers are approved', () => {
    expect(codes('Free delivery today!', {...brand, approvedOffers: []})).toEqual(['unverified_offer']);
  });

  it('flags testimonials and ratings', () => {
    expect(codes('Rated 4.9 stars by our guests')).toContain('possible_testimonial');
    expect(codes('Over 10k+ happy customers')).toContain('possible_testimonial');
  });

  it('flags do-not-say terms', () => {
    expect(codes('The CHEAPEST coffee in Dhaka')).toEqual(['restricted_term']);
  });
});
