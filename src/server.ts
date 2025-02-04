import {QueryResult} from 'pg';
import {notificationsApi, jobsApi} from './config/api-config';

const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const cron = require('node-cron');
const db = require('./config/db-config');

const corsOptions = {
  origin:
    process.env.ORIGIN_URL ||
    process.env.OPENSHIFT_NODEJS_ORIGIN_URL ||
    'https://localhost:8000',
  credentials: true,
  optionsSuccessStatus: 200,
};

const searchNavigation = {
  baseScreen: 'Job',
  props: {
    screen: 'Search',
  },
} as const;

const constructJobNavigation = (jobId: string) => ({
  baseScreen: 'Job',
  props: {
    screen: 'JobDetails',
    params: {
      itemId: jobId,
    },
  },
});

const app = express();

app.use(express.json());
app.use(express.urlencoded({extended: false}));
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(helmet());

const port = process.env.PORT || '8000';

app.listen(port, () => {
  console.log(`server started at http://localhost:${port}`);
  console.log('Notifications API URL: ', process.env.NOTIFICATIONS_API_URL);
  console.log('Jobs API URL: ', process.env.JOBS_API_URL);
  console.log('PG HOST: ', process.env.PGHOST);
  console.log('PG PORT: ', process.env.PGPORT);
});

// NOTE for daily at 8 use '0 8 * * *'

const row = {
  location: 'BC',
  language: 'en',
  user_id: '661CE107AB6747B488BB667652A6010E',
  token:
    'd1ORLlcxnk87i4aJknEt-E:APA91bGLQvn5ye79v__JrV99asD2aGHkLzTesjC53oahJFdFYidRm2jNh5u6ElKZZ7gfXPe643z_75QEESNNmf8elYauN4vP8jpdQkjTKRkUUmQlkFxfz3c',
  platform: 'ios',
};

const keywords = [
  'Software Engineer',
  'Data Scientist',
  'Product Manager',
  'Graphic Designer',
  'Marketing Specialist',
  'Sales Manager',
  'Customer Service Representative',
  'Business Analyst',
  'Project Manager',
  'Web Developer',
  'Mobile Developer',
  'DevOps Engineer',
  'System Administrator',
  'Network Engineer',
  'Database Administrator',
  'IT Support Specialist',
  'Cybersecurity Analyst',
  'Cloud Architect',
  'Machine Learning Engineer',
  'AI Researcher',
  'Technical Writer',
  'UX/UI Designer',
  'Quality Assurance Engineer',
  'SEO Specialist',
  'Content Strategist',
  'Digital Marketing Manager',
  'Social Media Manager',
  'Financial Analyst',
  'Accountant',
  'Human Resources Manager',
  'Recruiter',
  'Operations Manager',
  'Office Manager',
  'Executive Assistant',
  'Legal Assistant',
  'Paralegal',
  'Medical Assistant',
  'Registered Nurse',
  'Pharmacist',
  'Physical Therapist',
  'Occupational Therapist',
  'Speech-Language Pathologist',
  'Radiologic Technologist',
  'Dental Hygienist',
  'Veterinary Technician',
  'Lab Technician',
  'Research Scientist',
  'Environmental Scientist',
  'Civil Engineer',
  'Mechanical Engineer',
  'Electrical Engineer',
  'Chemical Engineer',
  'Biomedical Engineer',
  'Aerospace Engineer',
  'Industrial Engineer',
  'Manufacturing Engineer',
  'Materials Scientist',
  'Geologist',
  'Geophysicist',
  'Petroleum Engineer',
  'Mining Engineer',
  'Agricultural Engineer',
  'Food Scientist',
  'Nutritionist',
  'Dietitian',
  'Chef',
  'Pastry Chef',
  'Baker',
  'Butcher',
  'Fishmonger',
  'Sommelier',
  'Barista',
  'Bartender',
  'Mixologist',
  'Waiter',
  'Waitress',
  'Host',
  'Hostess',
  'Hotel Manager',
  'Concierge',
  'Housekeeper',
  'Tour Guide',
  'Travel Agent',
  'Flight Attendant',
  'Pilot',
  'Co-Pilot',
  'Air Traffic Controller',
  'Marine Biologist',
  'Oceanographer',
  'Meteorologist',
  'Astronomer',
  'Astrophysicist',
  'Cosmologist',
  'Physicist',
  'Chemist',
  'Biologist',
  'Microbiologist',
  'Geneticist',
  'Ecologist',
];

cron.schedule(
  '*/2 * * * *',
  async () => {
    console.log('===== START CRON JOB =====');
    const minimumPostedDate = new Date();
    minimumPostedDate.setDate(minimumPostedDate.getDate() - 1);
    minimumPostedDate.setHours(8);
    minimumPostedDate.setMinutes(0);
    minimumPostedDate.setSeconds(0);
    minimumPostedDate.setMilliseconds(0);
    const usersNotified: string[] = [];

    try {
      console.log('Getting list of all stored job searches...');
      await db
        .query(
          `
            SELECT js.user_id, js.keyword, js.location, js.language, t.token, t.platform
            FROM job_searches js
            INNER JOIN tokens t ON js.user_id = t.user_id
            WHERE js.user_removed = FALSE
            `,
          [],
        )
        .then(async (jobSearches: QueryResult) => {
          console.log('Checking for new job postings...');
          // for each job search, check if there's new job postings //
          // for await (const row of jobSearches.rows) {
          for await (const keyword of keywords) {
            // console.log(
            //   `keyword: ${row.keyword}, location: ${row.location}, user: ${row.user_id}`,
            // );
            try {
              const jobsResp = await jobsApi.get('Jobs/SearchJobs', {
                data: {
                  jobTitle: keyword,
                  location: row.location,
                  language: row.language,
                  minimumPostedDate: minimumPostedDate,
                },
              });

              // if there is new job postings, and the user hasn't been sent a push notification yet, send them one //
              if (
                jobsResp.data.count > 0 &&
                !usersNotified.includes(row.user_id)
              ) {
                usersNotified.push(row.user_id);
                try {
                  const jobPostingId = jobsResp.data.jobs[0].JobId;
                  await notificationsApi.post(
                    'Messaging/Send',
                    {
                      title:
                        row.language.toUpperCase() === 'EN'
                          ? 'New Jobs Posted'
                          : "Nouvelles offres d'emploi",
                      content:
                        row.language.toUpperCase() === 'EN'
                          ? 'There are new job postings for one or more of your saved job searches!'
                          : 'Il y a de nouvelles offres d’emploi pour une ou plusieurs de vos recherches d’emploi sauvegardées!',
                      token: row.token,
                      platform: row.platform,
                      dryRun: false,
                      data:
                        jobsResp.data.count > 1 || !jobPostingId
                          ? searchNavigation
                          : constructJobNavigation(jobPostingId),
                    },
                    {
                      auth: {
                        username: process.env.NOTIFICATIONS_API_USER || '',
                        password: process.env.NOTIFICATIONS_API_PASS || '',
                      },
                    },
                  );
                } catch (e: any) {
                  console.log(
                    'Error sending notification. Message: ',
                    e.message,
                  );
                }
              }
            } catch (e: any) {
              console.log('Error searching jobs. Message: ', e.message);
            }
          }
        });

      console.log('===== END CRON JOB =====');
    } catch (e: any) {
      console.log(e.message);
    }
  },
  {
    scheduled: true,
    timezone: 'America/Los_Angeles',
  },
);
