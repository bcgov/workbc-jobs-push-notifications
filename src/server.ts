import {notificationsApi, jobsApi} from './config/api-config';

const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const cron = require('node-cron');
const db = require('./config/db-config');
type JobSearch = {
  user_id: string;
  keyword: string;
  location: string;
  language: string;
  token: string;
  platform: string;
};

type JobSearchesResponse = {
  rows: JobSearch[];
};
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

function getFulfilledPromises<T>(results: Array<PromiseSettledResult<T>>): T[] {
  return results
    .filter(
      (result): result is PromiseFulfilledResult<T> =>
        result.status === 'fulfilled',
    )
    .map(result => result.value);
}

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
  console.log('===== STARTING SERVER =====', new Date());
  console.log(`server started at http://localhost:${port}`);
  console.log('Notifications API URL: ', process.env.NOTIFICATIONS_API_URL);
  console.log('Jobs API URL: ', process.env.JOBS_API_URL);
  console.log('PG HOST: ', process.env.PGHOST);
  console.log('PG PORT: ', process.env.PGPORT);
});

// NOTE for daily at 8 use '0 8 * * *'

cron.schedule(
  '0 8 * * *',
  async () => {
    console.log('===== START CRON JOB =====');
    const minimumPostedDate = new Date();
    minimumPostedDate.setDate(minimumPostedDate.getDate() - 1);
    minimumPostedDate.setHours(8);
    minimumPostedDate.setMinutes(0);
    minimumPostedDate.setSeconds(0);
    minimumPostedDate.setMilliseconds(0);

    try {
      console.log('Getting list of all stored job searches...');
      const jobSearches: JobSearchesResponse = await db.query(
        `
          SELECT js.user_id, js.keyword, js.location, js.language, t.token, t.platform
          FROM job_searches js
          INNER JOIN tokens t ON js.user_id = t.user_id
          WHERE js.user_removed = FALSE
          AND t.created_date = (
          SELECT MAX(created_date)
          FROM tokens
          WHERE user_id = js.user_id
          )
          `,
        [],
      );
      const maps: Map<string, JobSearch[]>[] = [];
      let currentMap = new Map<string, JobSearch[]>();

      for (const row of jobSearches.rows) {
        if (currentMap.has(row.user_id)) {
          currentMap.get(row.user_id)?.push(row);
        } else {
          currentMap.set(row.user_id, [row]);
        }

        if (currentMap.size >= 100) {
          maps.push(currentMap);
          currentMap = new Map<string, JobSearch[]>();
        }
      }

      if (currentMap.size > 0) {
        maps.push(currentMap);
      }

      for await (const userIdMapToJobSearch of maps) {
        const resolvedJobSearches = await Promise.all(
          Array.from(userIdMapToJobSearch).map(
            async ([userId, jobSearches]) => {
              console.log('Checking for new job postings...');
              const newJobSearches = jobSearches;
              const jobSearchPromises = newJobSearches.map(async row => {
                console.log(
                  `keyword: ${row.keyword}, location: ${row.location}, user: ${row.user_id}`,
                );
                try {
                  return await jobsApi.get('Jobs/SearchJobs', {
                    data: {
                      jobTitle: row.keyword,
                      location: row.location,
                      language: row.language,
                      minimumPostedDate: minimumPostedDate,
                    },
                  });
                } catch (e: any) {
                  console.log('Error searching jobs. Message: ', e.message);
                }
              });
              const awaitedPromises =
                await Promise.allSettled(jobSearchPromises);
              const fulfilledPromises = getFulfilledPromises(awaitedPromises);
              return {
                userId: userId,
                newJobs: fulfilledPromises
                  .map(fulfilledPromise => {
                    return fulfilledPromise?.data;
                  })
                  .filter(data => data !== undefined),
              };
            },
          ),
        );
        await Promise.all(
          resolvedJobSearches.map(async ({userId, newJobs}) => {
            try {
              const firstJobPostingId = newJobs[0]?.jobs?.[0]?.JobId;
              const userJobSearch = userIdMapToJobSearch.get(userId)?.[0];
              if (userJobSearch) {
                const data =
                  newJobs.length > 1 || !firstJobPostingId
                    ? searchNavigation
                    : constructJobNavigation(firstJobPostingId);
                await notificationsApi.post(
                  'messaging/send',
                  {
                    title:
                      userJobSearch.language.toUpperCase() === 'EN'
                        ? 'New Jobs Posted'
                        : "Nouvelles offres d'emploi",
                    content:
                      userJobSearch.language.toUpperCase() === 'EN'
                        ? 'There are new job postings for one or more of your saved job searches!'
                        : 'Il y a de nouvelles offres d’emploi pour une ou plusieurs de vos recherches d’emploi sauvegardées!',
                    token: userJobSearch.token,
                    platform: userJobSearch.platform,
                    dryRun: false,
                    data,
                  },
                  {
                    auth: {
                      username: process.env.NOTIFICATIONS_API_USER || '',
                      password: process.env.NOTIFICATIONS_API_PASS || '',
                    },
                  },
                );
              }
            } catch (e: any) {
              console.log('Error sending notification. Message: ', e.message);
            }
          }),
        );
      }
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
