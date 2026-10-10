// Validation for driver applications. Only expected fields are read.
import { clean, normalPhone } from './validate.js';
import { VEHICLES } from './pricing.js';
import { PRIVACY_NOTICE_VERSION } from './privacy.js';

export function parseApplication(body) {
  if (!body || typeof body !== 'object') return { error: 'Send the application as JSON.' };
  const name = clean(body.name, 80);
  const phone = normalPhone(body.phone);
  const vehicleType = clean(body.vehicle_type, 10);
  const vehicleModel = clean(body.vehicle_model, 60);
  // One stored form per plate, so "GR4521-22" and "gr 4521 22" cannot register twice: "GR 4521-22".
  const pm = /^([A-Z]{1,3})[\s-]*(\d{1,5})[\s-]*(\d{2}|[A-Z])?$/.exec(clean(body.plate, 15).toUpperCase());
  const plate = pm ? `${pm[1]} ${pm[2]}${pm[3] ? '-' + pm[3] : ''}` : '';
  const baseAirport = clean(body.base_airport, 3).toUpperCase();

  if (name.length < 3 || !/\s/.test(name)) return { error: 'Enter your full name as it appears on your Ghana Card.' };
  if (!phone || !/^\+233\d{9}$/.test(phone)) return { error: 'Enter your Ghana WhatsApp number, for example 024 411 2087.' };
  if (!VEHICLES[vehicleType]) return { error: 'Choose your vehicle size.' };
  if (vehicleModel.length < 3) return { error: 'Enter your vehicle make and model, for example Toyota Corolla.' };
  if (!plate) return { error: 'Enter your registration plate, for example GR 4521-22.' };
  if (!/^[A-Z]{3}$/.test(baseAirport)) return { error: 'Choose the airport you will work from.' };
  if (body.privacy_version !== PRIVACY_NOTICE_VERSION) return { error: 'The privacy notice has been updated. Refresh the page and read it again.' };
  if (body.privacy_notice !== true || body.vetting !== true) return { error: 'Tick both required boxes to apply.' };
  if (body.adult !== true) return { error: 'You must be 18 or over to drive with Woezor.' };

  return { data: { name, phone, vehicleType, vehicleModel, plate, baseAirport, marketing: body.marketing === true } };
}

export const VETTING_CHECKS = ['ghana_card', 'drivers_licence', 'dvla_ride_hailing', 'police_clearance', 'vehicle_roadworthy'];
